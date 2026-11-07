'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Nav from '../components/Nav';
import { listCredentials, me, startRun } from '../lib/api';

/**
 * Only providers with a real adapter (`packages/adapters/src`) are selectable — see
 * PLAN.md Phase 3 for the rest. `gemini`, `deepseek`, `grok`, and `ollama` are not
 * agentic (see each adapter's own doc comment): they stream a plain response, neither
 * edits files or runs tools. `ollama` is also PLAN.md's no-credential control case —
 * selecting it needs no stored credential at all, only a reachable `OLLAMA_URL` on the
 * proxy (see `apps/proxy/src/providers.ts`).
 */
const AVAILABLE_PROVIDERS = ['claude', 'gemini', 'deepseek', 'grok', 'ollama'];

export default function HomePage(): React.JSX.Element | null {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [task, setTask] = useState('');
  const [providers, setProviders] = useState<string[]>(['claude']);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  /** `null` while loading — providers render enabled-but-unbadged until this resolves,
   *  rather than flash a "not configured" badge on every provider for a moment. */
  const [configuredProviders, setConfiguredProviders] = useState<Set<string> | null>(
    null,
  );

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
    listCredentials()
      .then((creds) => {
        // ollama needs no stored credential at all (see AVAILABLE_PROVIDERS' comment).
        setConfiguredProviders(new Set(['ollama', ...creds.map((c) => c.provider)]));
      })
      .catch(() => {
        setConfiguredProviders(new Set(['ollama']));
      });
  }, [authChecked]);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start the run.');
      setSubmitting(false);
    }
  }

  if (authError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">{authError}</p>
      </main>
    );
  }

  if (!authChecked) return null;

  return (
    <>
      <Nav current="/" />
      <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
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
          {AVAILABLE_PROVIDERS.map((provider) => {
            const configured = configuredProviders?.has(provider) ?? true;
            return (
              <label key={provider} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={providers.includes(provider)}
                  onChange={() => {
                    toggleProvider(provider);
                  }}
                />
                {provider}
                {configuredProviders !== null && !configured && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-300">
                    No API key —{' '}
                    <a href="/settings" className="underline">
                      add one
                    </a>
                  </span>
                )}
              </label>
            );
          })}
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
    </>
  );
}
