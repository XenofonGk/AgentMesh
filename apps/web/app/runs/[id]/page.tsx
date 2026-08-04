'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { AgentEvent } from '@agentmesh/core';
import {
  getRun,
  me,
  reviewFileEdit,
  subscribeToAttempt,
  type AttemptSummary,
  type ReviewStatus,
  type RunDetail,
} from '../../../lib/api';

/**
 * The wire shape the SSE route actually sends — `AgentEvent` plus the review verdict,
 * which lives in the DB/API layer, not in `packages/core`'s `AgentEvent` (CLAUDE.md:
 * that type is never widened locally). See `apps/api/src/events/routes.ts`'s `write()`.
 */
type WireEvent = AgentEvent & { reviewStatus: ReviewStatus };

function formatStats(attempt: AttemptSummary): string | null {
  const parts: string[] = [];
  if (attempt.costUsd !== null) parts.push(`$${attempt.costUsd}`);
  if (attempt.latencyMs !== null) parts.push(`${(attempt.latencyMs / 1000).toFixed(1)}s`);
  if (attempt.inputTokens !== null && attempt.outputTokens !== null) {
    parts.push(`${attempt.inputTokens.toString()}→${attempt.outputTokens.toString()} tok`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Consecutive `message_delta`s render as one growing paragraph, not one line per
 * chunk — adapter-authoring's whole point (rule 4, "stream incrementally") is wasted on
 * the reader if the UI un-streams it back into a wall of one-line fragments.
 */
interface TextBlock {
  kind: 'text';
  role: 'assistant';
  text: string;
}
interface ToolBlock {
  kind: 'tool';
  name: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
}
interface NoteBlock {
  kind: 'thinking' | 'error' | 'done';
  detail: string;
}
interface FileEditBlock {
  kind: 'file_edit';
  path: string;
  diff: string;
  /** DB id of the underlying event — what the review PATCH addresses. Absent only if
   *  the SSE `id:` line was somehow missing, which never happens in practice. */
  eventId: string | null;
  reviewStatus: ReviewStatus;
}
type Block = TextBlock | ToolBlock | NoteBlock | FileEditBlock;

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="overflow-x-auto text-xs leading-relaxed">
      {diff.split('\n').map((line, index) => {
        const color = line.startsWith('+') && !line.startsWith('+++')
          ? 'bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-400'
          : line.startsWith('-') && !line.startsWith('---')
            ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-400'
            : line.startsWith('@@')
              ? 'text-blue-600 dark:text-blue-400'
              : '';
        return (
          <div key={index} className={`px-2 ${color}`}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

interface StoredEvent {
  id: string | null;
  event: WireEvent;
}

function reduceEvents(stored: StoredEvent[]): Block[] {
  const blocks: Block[] = [];
  const toolIndex = new Map<string, number>();

  for (const { id, event } of stored) {
    switch (event.type) {
      case 'message_delta': {
        const last = blocks.at(-1);
        if (last?.kind === 'text') {
          last.text += event.text;
        } else {
          blocks.push({ kind: 'text', role: 'assistant', text: event.text });
        }
        break;
      }
      case 'tool_call': {
        toolIndex.set(event.toolCallId, blocks.length);
        blocks.push({ kind: 'tool', name: event.name, input: event.input });
        break;
      }
      case 'tool_result': {
        const index = toolIndex.get(event.toolCallId);
        const block = index !== undefined ? blocks[index] : undefined;
        if (block?.kind === 'tool') {
          block.output = event.output;
          block.isError = event.isError;
        }
        break;
      }
      case 'file_edit':
        blocks.push({
          kind: 'file_edit',
          path: event.path,
          diff: event.diff,
          eventId: id,
          reviewStatus: event.reviewStatus,
        });
        break;
      case 'thinking':
        blocks.push({ kind: 'thinking', detail: event.text });
        break;
      case 'error':
        blocks.push({ kind: 'error', detail: event.message });
        break;
      case 'done':
        blocks.push({ kind: 'done', detail: event.outcome });
        break;
    }
  }

  return blocks;
}

function AttemptPanel({ attempt }: { attempt: AttemptSummary }) {
  const { id: attemptId, provider } = attempt;
  const [events, setEvents] = useState<StoredEvent[]>([]);
  /** Optimistic overrides for the review verdicts just clicked, keyed by event id — so
   *  a click reflects instantly rather than waiting on a page reload / SSE echo. */
  const [reviewOverrides, setReviewOverrides] = useState<Record<string, ReviewStatus>>(
    {},
  );
  const [reviewPending, setReviewPending] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const source = subscribeToAttempt(attemptId);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as WireEvent;
      const id = message.lastEventId !== '' ? message.lastEventId : null;
      setEvents((current) => [...current, { id, event }]);
    };
    return () => {
      source.close();
    };
  }, [attemptId]);

  const blocks = reduceEvents(events);
  const done = events.find(
    (stored): stored is StoredEvent & { event: Extract<WireEvent, { type: 'done' }> } =>
      stored.event.type === 'done',
  )?.event;

  async function handleReview(
    eventId: string,
    status: Extract<ReviewStatus, 'approved' | 'rejected'>,
  ): Promise<void> {
    setReviewPending((current) => ({ ...current, [eventId]: true }));
    try {
      const ok = await reviewFileEdit(attemptId, eventId, status);
      if (ok) {
        setReviewOverrides((current) => ({ ...current, [eventId]: status }));
      }
    } finally {
      setReviewPending((current) => ({ ...current, [eventId]: false }));
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <span className="font-medium">{provider}</span>
        <span className="flex items-center gap-2 text-xs text-neutral-500">
          {formatStats(attempt) && <span>{formatStats(attempt)}</span>}
          <span>{done ? done.outcome : 'running…'}</span>
        </span>
      </header>
      <div className="flex-1 overflow-y-auto p-4 text-sm">
        {blocks.length === 0 && <p className="text-neutral-500">Waiting for output…</p>}
        {blocks.map((block, index) => {
          if (block.kind === 'text') {
            return (
              <p key={index} className="mb-3 whitespace-pre-wrap">
                {block.text}
              </p>
            );
          }
          if (block.kind === 'tool') {
            return (
              <pre
                key={index}
                className={`mb-3 overflow-x-auto rounded-md p-2 text-xs ${
                  block.isError
                    ? 'bg-red-50 dark:bg-red-950'
                    : 'bg-neutral-100 dark:bg-neutral-900'
                }`}
              >
                {block.name}({JSON.stringify(block.input)})
                {block.output !== undefined ? ` → ${JSON.stringify(block.output)}` : ''}
              </pre>
            );
          }
          if (block.kind === 'file_edit') {
            const eventId = block.eventId;
            const status = eventId
              ? (reviewOverrides[eventId] ?? block.reviewStatus)
              : block.reviewStatus;
            const pending = eventId ? (reviewPending[eventId] ?? false) : false;
            return (
              <div
                key={index}
                className="mb-3 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800"
              >
                <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50 px-2 py-1 dark:border-neutral-800 dark:bg-neutral-900">
                  <span className="font-mono text-xs">{block.path}</span>
                  <div className="flex items-center gap-2">
                    {status === 'pending' && eventId ? (
                      <>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => void handleReview(eventId, 'approved')}
                          className="rounded border border-green-600 px-2 py-0.5 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50 dark:text-green-400 dark:hover:bg-green-950"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => void handleReview(eventId, 'rejected')}
                          className="rounded border border-red-600 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950"
                        >
                          Reject
                        </button>
                      </>
                    ) : (
                      <span
                        className={`text-xs font-medium ${
                          status === 'approved'
                            ? 'text-green-700 dark:text-green-400'
                            : status === 'rejected'
                              ? 'text-red-700 dark:text-red-400'
                              : 'text-neutral-500'
                        }`}
                      >
                        {status}
                      </span>
                    )}
                  </div>
                </div>
                <DiffView diff={block.diff} />
              </div>
            );
          }
          return (
            <p key={index} className="mb-3 text-xs text-neutral-500 italic">
              [{block.kind}] {block.detail}
            </p>
          );
        })}
      </div>
    </section>
  );
}

export default function RunPage(): React.JSX.Element | null {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    void me()
      .then((user) => {
        if (!user) {
          router.replace('/login');
          return;
        }
        setAuthChecked(true);
      })
      .catch(() => {
        setAuthError('Could not reach the API. Is it running?');
      });
  }, [router]);

  useEffect(() => {
    if (!authChecked) return;
    void getRun(params.id).then(setRun);
  }, [authChecked, params.id]);

  if (authError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">{authError}</p>
      </main>
    );
  }

  if (!authChecked) return null;
  if (!run) return <main className="p-6">Loading…</main>;

  return (
    <main className="flex h-screen flex-col gap-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">{run.task}</h1>
        <p className="text-xs text-neutral-500">
          {run.status} · started {new Date(run.createdAt).toLocaleString()}
        </p>
      </div>
      <div className="flex min-h-0 flex-1 gap-4">
        {run.attempts.map((attempt) => (
          <AttemptPanel key={attempt.id} attempt={attempt} />
        ))}
      </div>
    </main>
  );
}
