'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Nav from '../../../components/Nav';
import {
  cancelAttempt,
  getChat,
  sendChatMessage,
  me,
  type ChatDetail,
  type ChatMessage,
} from '../../../lib/api';

const POLL_INTERVAL_MS = 2000;

/** Merges by id, keeping arrival order — what the POST response and the progress
 *  poll both need, since a message can land in either and must not show twice. */
function mergeMessages(
  current: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ChatMessage[] {
  const seen = new Set(current.map((m) => m.id));
  const added = incoming.filter((m) => !seen.has(m.id));
  return added.length > 0 ? [...current, ...added] : [...current];
}

function roleColor(role: string): string {
  if (role === 'user') return 'text-neutral-900 dark:text-neutral-100';
  // A handful of fixed colors cycled by provider name so each participant stays
  // visually distinct turn to turn without needing a color picked per adapter.
  const palette = [
    'text-blue-700 dark:text-blue-400',
    'text-purple-700 dark:text-purple-400',
    'text-emerald-700 dark:text-emerald-400',
    'text-orange-700 dark:text-orange-400',
    'text-pink-700 dark:text-pink-400',
  ];
  let hash = 0;
  for (const char of role) hash = (hash * 31 + char.charCodeAt(0)) % palette.length;
  return palette[hash]!;
}

export default function ChatPage(): React.JSX.Element | null {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [chatLoadFailed, setChatLoadFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Belt-and-suspenders: clears the poll if the user navigates away mid-send.
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

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

  const loadChat = useCallback((): void => {
    setChatLoadFailed(false);
    void getChat(params.id).then((loaded) => {
      if (loaded) {
        setChat(loaded);
      } else {
        setChatLoadFailed(true);
      }
    });
  }, [params.id]);

  useEffect(() => {
    if (!authChecked) return;
    loadChat();
  }, [authChecked, loadChat]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat?.messages.length]);

  async function handleSend(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!draft.trim() || !chat) return;
    const content = draft;
    setDraft('');
    setSendError(null);
    setSending(true);

    // `sendChatMessage` below doesn't resolve until the whole round is done — this
    // poll is what makes replies appear one at a time instead of all at once at the
    // end, and is also where `runningAttempt` (for the Stop button) comes from.
    pollRef.current = setInterval(() => {
      void getChat(params.id).then((latest) => {
        if (!latest) return;
        setChat((current) =>
          current
            ? { ...latest, messages: mergeMessages(current.messages, latest.messages) }
            : current,
        );
      });
    }, POLL_INTERVAL_MS);

    try {
      const newMessages = await sendChatMessage(chat.id, content);
      setChat((current) =>
        current
          ? { ...current, messages: mergeMessages(current.messages, newMessages), runningAttempt: null }
          : current,
      );
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send message.');
      setDraft(content);
    } finally {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setSending(false);
    }
  }

  async function handleCancel(): Promise<void> {
    if (!chat?.runningAttempt) return;
    setCancelling(true);
    await cancelAttempt(chat.runningAttempt.id);
    setCancelling(false);
    // The in-flight POST /chats/:id/messages resolves on its own once chat-service.ts
    // sees the cancellation and ends the round — no need to touch state here beyond
    // letting the next poll tick pick up the "stopped" message it records.
  }

  if (authError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">{authError}</p>
      </main>
    );
  }

  if (!authChecked) return null;

  if (chatLoadFailed) {
    return (
      <>
        <Nav current="/chat" />
        <main className="mx-auto flex max-w-2xl flex-col items-center gap-3 px-6 py-12 text-center">
          <p className="text-sm text-red-600 dark:text-red-400">
            Could not load this chat — it may not exist, or belong to someone else.
          </p>
          <button type="button" onClick={loadChat} className="text-sm underline">
            Retry
          </button>
        </main>
      </>
    );
  }

  if (!chat) {
    return (
      <>
        <Nav current="/chat" />
        <main className="p-6">Loading…</main>
      </>
    );
  }

  return (
    <>
      <Nav current="/chat" />
      <main className="flex h-[calc(100vh-49px)] flex-col">
        <header className="border-b border-neutral-200 px-6 py-3 text-sm text-neutral-500 dark:border-neutral-800">
          {chat.providers.join(' → ')}
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {chat.messages.length === 0 && (
            <p className="text-sm text-neutral-500">Say something to get started.</p>
          )}
          <div className="flex flex-col gap-4">
            {chat.messages.map((message) => (
              <div key={message.id}>
                <div className={`mb-1 text-xs font-medium ${roleColor(message.role)}`}>
                  {message.role}
                </div>
                <p className="whitespace-pre-wrap text-sm">{message.content}</p>
              </div>
            ))}
          </div>
          {sending && (
            <p className="mt-4 flex items-center gap-2 text-sm text-neutral-500">
              {chat.runningAttempt
                ? `${chat.runningAttempt.provider} is replying…`
                : `Waiting for ${chat.providers.join(', ')}…`}
              {chat.runningAttempt && !cancelling && (
                <button
                  type="button"
                  onClick={() => void handleCancel()}
                  className="rounded border border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  Stop
                </button>
              )}
              {cancelling && <span className="text-xs">stopping…</span>}
            </p>
          )}
          <div ref={bottomRef} />
        </div>

        <form
          onSubmit={(event) => void handleSend(event)}
          className="flex gap-2 border-t border-neutral-200 p-4 dark:border-neutral-800"
        >
          <input
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            placeholder="Send a message…"
            disabled={sending}
          />
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>
        {sendError && (
          <p className="px-4 pb-3 text-sm text-red-600 dark:text-red-400">{sendError}</p>
        )}
      </main>
    </>
  );
}
