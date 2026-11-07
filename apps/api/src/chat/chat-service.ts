/**
 * The round-robin relay: unlike a Run's parallel bake-off, a chat's providers take
 * turns, each one seeing the whole transcript — the user's messages and every prior
 * provider's reply, including earlier replies in the *same* round — before it runs.
 * "Round-robin" here means strict turn order within a round (`chat.providers`'
 * order), not that control returns to the user between every provider.
 *
 * Deliberately synchronous: this function doesn't return until every provider in the
 * round has replied (or failed), so the HTTP response IS the result — no SSE, no
 * polling for the caller. Each provider's container takes real wall-clock time
 * (cold model load included), so a multi-provider chat message can take a while; that
 * trade is simplicity now over a streaming protocol later, which can be layered on
 * without changing this module's shape if it's ever needed.
 */
import { desc, eq } from 'drizzle-orm';
import type { Database } from '@agentmesh/db';
import { schema } from '@agentmesh/db';
import type { Orchestrator } from '../orchestrator/orchestrator.js';

const { chats, chatMessages, attempts, agentEvents } = schema;

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);
const POLL_INTERVAL_MS = 750;
/** A little past the orchestrator's own 10-minute attempt cap — that timeout always
 *  fires first and moves the attempt to a terminal status; this is only the backstop
 *  against this function waiting forever if that somehow didn't happen. */
const WAIT_TIMEOUT_MS = 11 * 60 * 1000;

function imageForProvider(provider: string): {
  provider: string;
  image: string;
  command: readonly string[];
} {
  return { provider, image: `agentmesh/${provider}:latest`, command: ['run'] };
}

export interface ChatMessageRow {
  id: string;
  turn: number;
  role: string;
  content: string;
  createdAt: Date;
}

export interface SendChatMessageOptions {
  chatId: string;
  userId: string;
  content: string;
  proxyUrl: string;
  apiUrl: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One line per prior message — what each provider's turn is actually prompted with. */
function formatTranscript(
  rows: readonly { role: string; content: string }[],
  nextProvider: string,
): string {
  const lines = rows.map((row) => `${row.role}: ${row.content}`);
  lines.push(
    `You are "${nextProvider}" in this conversation. Reply as yourself, continuing naturally from what came before.`,
  );
  return lines.join('\n\n');
}

interface AttemptOutcome {
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  errorMessage: string | null;
}

async function waitForAttempt(db: Database, attemptId: string): Promise<AttemptOutcome> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const [row] = await db
      .select({ status: attempts.status, errorMessage: attempts.errorMessage })
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    if (row && TERMINAL_STATUSES.has(row.status)) {
      return { status: row.status as AttemptOutcome['status'], errorMessage: row.errorMessage };
    }
    if (Date.now() > deadline) {
      return { status: 'timed_out', errorMessage: 'timed out waiting for a reply' };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Concatenates every `message_delta`'s text, in event order — the same reduction
 *  `apps/web`'s `reduceEvents` does client-side, done here server-side because the
 *  transcript the *next* provider's turn needs is plain text, not `AgentEvent`s. */
async function reconstructReplyText(db: Database, attemptId: string): Promise<string> {
  const rows = await db
    .select({ payload: agentEvents.payload })
    .from(agentEvents)
    .where(eq(agentEvents.attemptId, attemptId))
    .orderBy(agentEvents.id);

  let text = '';
  for (const row of rows) {
    const event = row.payload as { type: string; text?: string };
    if (event.type === 'message_delta' && typeof event.text === 'string') {
      text += event.text;
    }
  }
  return text;
}

/**
 * Appends the user's message, then runs the chat's providers in order, each prompted
 * with the transcript so far. Returns every message created this call (the user's plus
 * one per provider), or `null` if the chat doesn't exist or belongs to someone else.
 */
export async function sendChatMessage(
  db: Database,
  orchestrator: Orchestrator,
  options: SendChatMessageOptions,
): Promise<ChatMessageRow[] | null> {
  const [chat] = await db.select().from(chats).where(eq(chats.id, options.chatId));
  if (!chat || chat.userId !== options.userId) return null;

  const [latest] = await db
    .select({ turn: chatMessages.turn })
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chat.id))
    .orderBy(desc(chatMessages.turn))
    .limit(1);
  const turn = (latest?.turn ?? -1) + 1;

  const [userMessage] = await db
    .insert(chatMessages)
    .values({ chatId: chat.id, turn, role: 'user', content: options.content })
    .returning();
  if (!userMessage) throw new Error('failed to record chat message');

  const newRows: ChatMessageRow[] = [userMessage];

  for (const provider of chat.providers) {
    const priorRows = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chat.id))
      .orderBy(chatMessages.turn, chatMessages.createdAt);

    const attemptId = await orchestrator.startChatAttempt(
      chat.id,
      options.userId,
      formatTranscript(priorRows, provider),
      options.proxyUrl,
      options.apiUrl,
      imageForProvider(provider),
    );

    const outcome = await waitForAttempt(db, attemptId);
    const content =
      outcome.status === 'succeeded'
        ? (await reconstructReplyText(db, attemptId)) || '(empty reply)'
        : outcome.status === 'cancelled'
          ? `⏹ ${provider} was stopped.`
          : `⚠️ ${provider} failed: ${outcome.errorMessage ?? 'unknown error'}`;

    const [reply] = await db
      .insert(chatMessages)
      .values({ chatId: chat.id, turn, role: provider, content })
      .returning();
    if (!reply) throw new Error('failed to record chat reply');
    newRows.push(reply);

    // Cancelling one provider's turn stops the round — the point of a "Stop" button
    // is to stop, not to still run every provider after the one actually cancelled.
    if (outcome.status === 'cancelled') break;
  }

  return newRows;
}
