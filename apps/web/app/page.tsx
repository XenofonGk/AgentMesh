'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { me, startRun } from '../lib/api';

/**
 * Only providers with a real adapter (`packages/adapters/src`) are selectable — see
 * PLAN.md Phase 3 for the rest. `gemini`, `deepseek`, and `grok` are not agentic (see
 * each adapter's own doc comment): they stream a plain response, neither edits files or
 * runs tools.
 */
const AVAILABLE_PROVIDERS = ['claude', 'gemini', 'deepseek', 'grok'];

export default function HomePage(): React.JSX.Element | null {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [task, setTask] = useState('');
  const [providers, setProviders] = useState<string[]>(['claude']);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void me().then((user) => {
      if (!user) {
        router.replace('/login');
        return;
      }
      setAuthChecked(true);
    });
  }, [router]);

  function toggleProvider(provider: string): void {
    setProviders((current) =>
      current.includes(provider)
        ? current.filter((entry) => entry !== provider)
        : [...current, provider],
    );
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (providers.length === 0) {
      setError('Pick at least one provider.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const { runId } = await startRun(task, providers);
      router.push(`/runs/${runId}`);
    } catch {
      setError('Failed to start the run.');
      setSubmitting(false);
    }
  }

  if (!authChecked) return null;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">AgentMesh</h1>
        <p className="mt-2 text-neutral-600 dark:text-neutral-400">
          Describe a task and watch an agent work on it, live.
        </p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => void handleSubmit(event)}
      >
        <label className="flex flex-col gap-1 text-sm">
          Task
          <textarea
            className="min-h-32 rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
            required
            value={task}
            onChange={(event) => {
              setTask(event.target.value);
            }}
            placeholder="e.g. Add input validation to the signup form"
          />
        </label>

        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1">Providers</legend>
          {AVAILABLE_PROVIDERS.map((provider) => (
            <label key={provider} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={providers.includes(provider)}
                onChange={() => {
                  toggleProvider(provider);
                }}
              />
              {provider}
            </label>
          ))}
        </fieldset>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {submitting ? 'Starting…' : 'Start run'}
        </button>
      </form>
    </main>
  );
}
