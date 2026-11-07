'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Nav from '../../components/Nav';
import { listRuns, me, type RunSummary } from '../../lib/api';

function statusColor(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'text-green-700 dark:text-green-400';
    case 'failed':
      return 'text-red-700 dark:text-red-400';
    default:
      return 'text-neutral-500';
  }
}

export default function RunsPage(): React.JSX.Element | null {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  function load(): void {
    setLoadError(null);
    listRuns()
      .then(setRuns)
      .catch(() => setLoadError('Could not load runs.'));
  }

  useEffect(() => {
    if (authChecked) load();
  }, [authChecked]);

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
      <Nav current="/runs" />
      <main className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Runs</h1>

        {loadError && (
          <div className="flex items-center gap-3 text-sm text-red-600 dark:text-red-400">
            <p>{loadError}</p>
            <button type="button" onClick={load} className="underline">
              Retry
            </button>
          </div>
        )}

        {!loadError && runs === null && (
          <p className="text-sm text-neutral-500">Loading…</p>
        )}

        {!loadError && runs !== null && runs.length === 0 && (
          <p className="text-sm text-neutral-500">
            No runs yet.{' '}
            <a href="/" className="underline">
              Start one
            </a>
            .
          </p>
        )}

        {!loadError && runs !== null && runs.length > 0 && (
          <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
            {runs.map((run) => (
              <li key={run.id}>
                <a
                  href={`/runs/${run.id}`}
                  className="flex items-center justify-between gap-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                >
                  <span className="truncate text-sm">{run.task}</span>
                  <span className="flex shrink-0 items-center gap-3 text-xs">
                    <span className={statusColor(run.status)}>{run.status}</span>
                    <span className="text-neutral-400">
                      {new Date(run.createdAt).toLocaleString()}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
