'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Nav from '../../components/Nav';
import { HistoryIcon, TrashIcon } from '../../components/icons';
import { deleteRun, listRuns, me, type RunSummary } from '../../lib/api';

const PAGE_SIZE = 50;

function statusBadge(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400';
    case 'failed':
      return 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400';
    default:
      return 'bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400';
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
      <main className="mx-auto max-w-3xl px-6 py-10 md:ml-60 md:py-14">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">Runs</h1>

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
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-neutral-300 py-16 text-center dark:border-neutral-700">
            <HistoryIcon className="size-6 text-neutral-400" />
            <p className="text-sm text-neutral-500">
              No runs yet.{' '}
              <a href="/" className="font-medium text-neutral-700 underline dark:text-neutral-300">
                Start one
              </a>
            </p>
          </div>
        )}

        {!loadError && runs !== null && runs.length > 0 && (
          <>
            <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
              {runs.map((run) => (
                <li key={run.id} className="flex items-center gap-2 hover:bg-neutral-50 dark:hover:bg-neutral-900">
                  <a
                    href={`/runs/${run.id}`}
                    className="flex min-w-0 flex-1 items-center justify-between gap-4 px-4 py-3"
                  >
                    <span className="truncate text-sm">{run.task}</span>
                    <span className="flex shrink-0 items-center gap-3 text-xs">
                      <span className={`rounded-full px-2 py-0.5 font-medium ${statusBadge(run.status)}`}>
                        {run.status}
                      </span>
                      <span className="text-neutral-400">
                        {new Date(run.createdAt).toLocaleString()}
                      </span>
                    </span>
                  </a>
                  {confirmingId === run.id ? (
                    <span className="flex shrink-0 items-center gap-2 pr-4 text-xs">
                      <button
                        type="button"
                        onClick={() => void handleDelete(run.id)}
                        className="rounded border border-red-300 px-2 py-1 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingId(null)}
                        className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingId(run.id)}
                      aria-label="Delete run"
                      className="mr-4 shrink-0 rounded p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
                    >
                      <TrashIcon className="size-4" />
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
