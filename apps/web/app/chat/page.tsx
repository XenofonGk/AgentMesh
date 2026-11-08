'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Nav from '../../components/Nav';
import ProviderPicker from '../../components/ProviderPicker';
import { ChatBubblesIcon, TrashIcon } from '../../components/icons';
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
const AVAILABLE_PROVIDERS = ['claude', 'gemini', 'deepseek', 'grok', 'chatgpt', 'ollama'];

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
      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-10 md:ml-60 md:py-14">
        <section>
          <h1 className="mb-1 text-2xl font-semibold tracking-tight">Group chat</h1>
          <p className="mb-5 text-sm text-neutral-500">
            Pick providers, in the order you want them to take turns. Each one sees the
            whole conversation, including what the others just said, before it replies —
            and you can keep sending follow-ups.
          </p>

          <div className="mb-5 flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Providers
            </span>
            <ProviderPicker
              providers={AVAILABLE_PROVIDERS}
              selected={providers}
              configured={configuredProviders}
              onToggle={toggleProvider}
            />
          </div>

          {createError && (
            <p className="mb-2 text-sm text-red-600 dark:text-red-400">{createError}</p>
          )}

          <button
            type="button"
            disabled={creating}
            onClick={() => void handleCreate()}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
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
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-neutral-300 py-16 text-center dark:border-neutral-700">
              <ChatBubblesIcon className="size-6 text-neutral-400" />
              <p className="text-sm text-neutral-500">No chats yet — start one above.</p>
            </div>
          )}
          {!listError && chatList !== null && chatList.length > 0 && (
            <>
              <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                {chatList.map((chat) => (
                  <li key={chat.id} className="flex items-center gap-2 hover:bg-neutral-50 dark:hover:bg-neutral-900">
                    <a
                      href={`/chat/${chat.id}`}
                      className="flex min-w-0 flex-1 items-center justify-between gap-4 px-4 py-3"
                    >
                      <span className="text-sm">{chat.providers.join(' → ')}</span>
                      <span className="shrink-0 text-xs text-neutral-400">
                        {new Date(chat.createdAt).toLocaleString()}
                      </span>
                    </a>
                    {confirmingId === chat.id ? (
                      <span className="flex shrink-0 items-center gap-2 pr-4 text-xs">
                        <button
                          type="button"
                          onClick={() => void handleDelete(chat.id)}
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
                        onClick={() => setConfirmingId(chat.id)}
                        aria-label="Delete chat"
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
        </section>
      </main>
    </>
  );
}
