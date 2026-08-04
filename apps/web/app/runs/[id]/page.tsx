'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { AgentEvent } from '@agentmesh/core';
import {
  getRun,
  me,
  subscribeToAttempt,
  type AttemptSummary,
  type RunDetail,
} from '../../../lib/api';

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
  kind: 'thinking' | 'file_edit' | 'error' | 'done';
  detail: string;
}
type Block = TextBlock | ToolBlock | NoteBlock;

function reduceEvents(events: AgentEvent[]): Block[] {
  const blocks: Block[] = [];
  const toolIndex = new Map<string, number>();

  for (const event of events) {
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
        blocks.push({ kind: 'file_edit', detail: event.path });
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
  const [events, setEvents] = useState<AgentEvent[]>([]);

  useEffect(() => {
    const source = subscribeToAttempt(attemptId);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as AgentEvent;
      setEvents((current) => [...current, event]);
    };
    return () => {
      source.close();
    };
  }, [attemptId]);

  const blocks = reduceEvents(events);
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: 'done' }> => event.type === 'done',
  );

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
