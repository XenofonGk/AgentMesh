'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Nav from '../../components/Nav';
import { deleteRun, listRuns, me, type RunSummary } from '../../lib/api';

const PAGE_SIZE = 50;

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
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  /** The row asking "delete this?" right now — at most one at a time, inline, no
   *  native confirm() dialog (nothing else in this app uses one). */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

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
      .then((rows) => {
        setRuns(rows);
        setHasMore(rows.length === PAGE_SIZE);
      })
      .catch(() => setLoadError('Could not load runs.'));
  }

  async function loadMore(): Promise<void> {
    if (!runs || runs.length === 0) return;
    setLoadingMore(true);
    try {
      const more = await listRuns(runs[runs.length - 1]!.createdAt);
      setRuns([...runs, ...more]);
      setHasMore(more.length === PAGE_SIZE);
    } catch {
      setLoadError('Could not load more runs.');
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    setConfirmingId(null);
    const ok = await deleteRun(id);
    if (ok) {
      setRuns((current) => current?.filter((r) => r.id !== id) ?? current);
    }
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
          <>
            <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
              {runs.map((run) => (
                <li key={run.id} className="flex items-center justify-between gap-4 py-3">
                  <a
                    href={`/runs/${run.id}`}
                    className="flex min-w-0 flex-1 items-center justify-between gap-4 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                  >
                    <span className="truncate text-sm">{run.task}</span>
                    <span className="flex shrink-0 items-center gap-3 text-xs">
                      <span className={statusColor(run.status)}>{run.status}</span>
                      <span className="text-neutral-400">
                        {new Date(run.createdAt).toLocaleString()}
                      </span>
                    </span>
                  </a>
                  {confirmingId === run.id ? (
                    <span className="flex shrink-0 items-center gap-2 text-xs">
                      Delete?
                      <button
                        type="button"
                        onClick={() => void handleDelete(run.id)}
                        className="text-red-600 underline dark:text-red-400"
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingId(null)}
                        className="text-neutral-500 underline"
                      >
                        No
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingId(run.id)}
                      className="shrink-0 text-xs text-neutral-400 hover:text-red-600 dark:hover:text-red-400"
                    >
                      Delete
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {hasMore && (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                className="mt-4 text-sm text-neutral-500 underline disabled:opacity-50"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        )}
      </main>
    </>
  );
}
