'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Nav from '../../components/Nav';
import {
  createChat,
  deleteChat,
  listChats,
  listCredentials,
  me,
  type ChatSummary,
} from '../../lib/api';

/** Same participant list `/` offers for a bake-off run — see that page's comment on
 *  why these five and not more. */
const AVAILABLE_PROVIDERS = ['claude', 'gemini', 'deepseek', 'grok', 'ollama'];

const PAGE_SIZE = 50;

export default function ChatListPage(): React.JSX.Element | null {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [chatList, setChatList] = useState<ChatSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [configuredProviders, setConfiguredProviders] = useState<Set<string> | null>(
    null,
  );
  const [providers, setProviders] = useState<string[]>(['claude']);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
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

  useEffect(() => {
    if (!authChecked) return;
    listChats()
      .then((rows) => {
        setChatList(rows);
        setHasMore(rows.length === PAGE_SIZE);
      })
      .catch(() => setListError('Could not load chats.'));
    listCredentials()
      .then((creds) => {
        setConfiguredProviders(new Set(['ollama', ...creds.map((c) => c.provider)]));
      })
      .catch(() => setConfiguredProviders(new Set(['ollama'])));
  }, [authChecked]);

  async function loadMore(): Promise<void> {
    if (!chatList || chatList.length === 0) return;
    setLoadingMore(true);
    try {
      const more = await listChats(chatList[chatList.length - 1]!.createdAt);
      setChatList([...chatList, ...more]);
      setHasMore(more.length === PAGE_SIZE);
    } catch {
      setListError('Could not load more chats.');
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    setConfirmingId(null);
    const ok = await deleteChat(id);
    if (ok) {
      setChatList((current) => current?.filter((c) => c.id !== id) ?? current);
    }
  }

  function toggleProvider(provider: string): void {
    setProviders((current) =>
      current.includes(provider)
        ? current.filter((entry) => entry !== provider)
        : [...current, provider],
    );
  }

  async function handleCreate(): Promise<void> {
    if (providers.length === 0) {
      setCreateError('Pick at least one provider.');
      return;
    }
    setCreateError(null);
    setCreating(true);
    try {
      const { chatId } = await createChat(providers);
      router.push(`/chat/${chatId}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to start chat.');
      setCreating(false);
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
      <Nav current="/chat" />
      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-8">
        <section>
          <h1 className="mb-1 text-2xl font-semibold tracking-tight">Group chat</h1>
          <p className="mb-4 text-sm text-neutral-500">
            Pick providers, in the order you want them to take turns. Each one sees the
            whole conversation, including what the others just said, before it replies —
            and you can keep sending follow-ups.
          </p>

          <fieldset className="mb-4 flex flex-col gap-2 text-sm">
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

          {createError && (
            <p className="mb-2 text-sm text-red-600 dark:text-red-400">{createError}</p>
          )}

          <button
            type="button"
            disabled={creating}
            onClick={() => void handleCreate()}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {creating ? 'Starting…' : 'Start chat'}
          </button>
        </section>

        <section>
          <h2 className="mb-3 text-lg font-medium">Past chats</h2>
          {listError && <p className="text-sm text-red-600 dark:text-red-400">{listError}</p>}
          {!listError && chatList === null && (
            <p className="text-sm text-neutral-500">Loading…</p>
          )}
          {!listError && chatList !== null && chatList.length === 0 && (
            <p className="text-sm text-neutral-500">No chats yet.</p>
          )}
          {!listError && chatList !== null && chatList.length > 0 && (
            <>
              <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
                {chatList.map((chat) => (
                  <li key={chat.id} className="flex items-center justify-between gap-4 py-3">
                    <a
                      href={`/chat/${chat.id}`}
                      className="flex min-w-0 flex-1 items-center justify-between gap-4 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                    >
                      <span className="text-sm">{chat.providers.join(' → ')}</span>
                      <span className="shrink-0 text-xs text-neutral-400">
                        {new Date(chat.createdAt).toLocaleString()}
                      </span>
                    </a>
                    {confirmingId === chat.id ? (
                      <span className="flex shrink-0 items-center gap-2 text-xs">
                        Delete?
                        <button
                          type="button"
                          onClick={() => void handleDelete(chat.id)}
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
                        onClick={() => setConfirmingId(chat.id)}
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
        </section>
      </main>
    </>
  );
}
