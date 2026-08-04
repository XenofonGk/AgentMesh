'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { AgentEvent, Usage } from '@agentmesh/core';
import { getRun, me, subscribeToAttempt, type RunDetail } from '../../../lib/api';

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

interface AttemptResult {
  outcome: string;
  usage: Usage | null;
}

function AttemptPanel({
  attemptId,
  provider,
  onDone,
}: {
  attemptId: string;
  provider: string;
  onDone: (attemptId: string, result: AttemptResult) => void;
}) {
  const [events, setEvents] = useState<AgentEvent[]>([]);

  useEffect(() => {
    const source = subscribeToAttempt(attemptId);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as AgentEvent;
      setEvents((current) => [...current, event]);
      if (event.type === 'done') {
        onDone(attemptId, { outcome: event.outcome, usage: event.usage });
      }
    };
    return () => {
      source.close();
    };
  }, [attemptId, onDone]);

  const blocks = reduceEvents(events);
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: 'done' }> => event.type === 'done',
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <span className="font-medium">{provider}</span>
        <span className="text-xs text-neutral-500">
          {done ? done.outcome : 'running…'}
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

function formatCost(costUsd: number | null): string {
  return costUsd === null ? '—' : `$${costUsd.toFixed(4)}`;
}

function formatLatency(latencyMs: number | null): string {
  return latencyMs === null ? '—' : `${(latencyMs / 1000).toFixed(1)}s`;
}

function formatTokens(tokens: number | null): string {
  return tokens === null ? '—' : tokens.toLocaleString();
}

/**
 * The whole point of the bake-off: put every attempt's cost/latency/tokens/outcome in
 * one table so they're comparable at a glance, not scattered across N scrolling panels.
 * Sourced from live `done` events (via `onDone`, below), not the initial `getRun` —
 * that snapshot is taken before any attempt has finished and would show stale nulls for
 * the whole run.
 */
function ComparisonTable({
  attempts,
  results,
}: {
  attempts: RunDetail['attempts'];
  results: Record<string, AttemptResult>;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-xs text-neutral-500 dark:border-neutral-800">
            <th className="px-4 py-2 font-medium">Provider</th>
            <th className="px-4 py-2 font-medium">Outcome</th>
            <th className="px-4 py-2 font-medium">Cost</th>
            <th className="px-4 py-2 font-medium">Latency</th>
            <th className="px-4 py-2 font-medium">Input tokens</th>
            <th className="px-4 py-2 font-medium">Output tokens</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((attempt) => {
            const result = results[attempt.id];
            return (
              <tr
                key={attempt.id}
                className="border-b border-neutral-200 last:border-0 dark:border-neutral-800"
              >
                <td className="px-4 py-2 font-medium">{attempt.provider}</td>
                <td className="px-4 py-2 text-neutral-500">
                  {result?.outcome ?? 'running…'}
                </td>
                <td className="px-4 py-2">
                  {formatCost(result?.usage?.costUsd ?? null)}
                </td>
                <td className="px-4 py-2">
                  {formatLatency(result?.usage?.latencyMs ?? null)}
                </td>
                <td className="px-4 py-2">
                  {formatTokens(result?.usage?.inputTokens ?? null)}
                </td>
                <td className="px-4 py-2">
                  {formatTokens(result?.usage?.outputTokens ?? null)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function RunPage(): React.JSX.Element | null {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [results, setResults] = useState<Record<string, AttemptResult>>({});

  useEffect(() => {
    void me().then((user) => {
      if (!user) {
        router.replace('/login');
        return;
      }
      setAuthChecked(true);
    });
  }, [router]);

  useEffect(() => {
    if (!authChecked) return;
    void getRun(params.id).then(setRun);
  }, [authChecked, params.id]);

  const handleDone = useCallback((attemptId: string, result: AttemptResult): void => {
    setResults((current) => ({ ...current, [attemptId]: result }));
  }, []);

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
      <ComparisonTable attempts={run.attempts} results={results} />
      <div className="flex min-h-0 flex-1 gap-4">
        {run.attempts.map((attempt) => (
          <AttemptPanel
            key={attempt.id}
            attemptId={attempt.id}
            provider={attempt.provider}
            onDone={handleDone}
          />
        ))}
      </div>
    </main>
  );
}
