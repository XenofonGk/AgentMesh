'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Nav from '../components/Nav';
import ProviderPicker from '../components/ProviderPicker';
import { listCredentials, me, startRun } from '../lib/api';

/**
 * Only providers with a real adapter (`packages/adapters/src`) are selectable — see
 * PLAN.md Phase 3 for the rest. `gemini`, `deepseek`, `grok`, and `ollama` are not
 * agentic (see each adapter's own doc comment): they stream a plain response, neither
 * edits files or runs tools. `ollama` is also PLAN.md's no-credential control case —
 * selecting it needs no stored credential at all, only a reachable `OLLAMA_URL` on the
 * proxy (see `apps/proxy/src/providers.ts`).
 */
const AVAILABLE_PROVIDERS = ['claude', 'gemini', 'deepseek', 'grok', 'chatgpt', 'ollama'];

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
      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-10 md:py-14 md:ml-60">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">New run</h1>
          <p className="mt-2 text-neutral-600 dark:text-neutral-400">
            Describe a task, pick one or more providers, and compare how each one
            handles it — side by side, live.
          </p>
        </div>

        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-neutral-700 dark:text-neutral-300">Task</span>
            <textarea
              className="min-h-32 rounded-lg border border-neutral-300 px-3 py-2.5 placeholder:text-neutral-400 focus-visible:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:placeholder:text-neutral-600"
              required
              value={task}
              onChange={(event) => {
                setTask(event.target.value);
              }}
              placeholder="e.g. Add input validation to the signup form"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Providers
            </span>
            <ProviderPicker
              providers={AVAILABLE_PROVIDERS}
              selected={providers}
              configured={configuredProviders}
              onToggle={toggleProvider}
            />
            {configuredProviders !== null &&
              AVAILABLE_PROVIDERS.some((p) => !configuredProviders.has(p)) && (
                <p className="text-xs text-neutral-500">
                  Providers marked "no key" need a credential first —{' '}
                  <a href="/settings" className="underline">
                    add one in Settings
                  </a>
                  .
                </p>
              )}
          </div>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="self-start rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {submitting ? 'Starting…' : 'Start run'}
          </button>
        </form>
      </main>
    </>
  );
}
