'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Nav from '../../../components/Nav';
import Avatar from '../../../components/Avatar';
import MessageContent from '../../../components/MessageContent';
import { AlertIcon, SendIcon, StopIcon } from '../../../components/icons';
import { roleColor } from '../../../lib/roleColor';
import {
  cancelAttempt,
  getChat,
  sendChatMessage,
  me,
  type ChatDetail,
  type ChatMessage,
} from '../../../lib/api';

const POLL_INTERVAL_MS = 2000;
const MAX_TEXTAREA_PX = 200;

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

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** `chat-service.ts` writes a stopped/failed turn as a short status line with a
 *  leading emoji marker — detected and re-rendered with a drawn icon instead of
 *  the raw character, and skipping markdown rendering for what's plain status
 *  text, not prose. */
function statusKind(content: string): 'stopped' | 'failed' | null {
  if (content.startsWith('⏹')) return 'stopped';
  if (content.startsWith('⚠️')) return 'failed';
  return null;
}

function StatusLine({ kind, text }: { kind: 'stopped' | 'failed'; text: string }) {
  const tone =
    kind === 'failed'
      ? 'text-red-700 dark:text-red-400'
      : 'text-neutral-500 dark:text-neutral-400';
  return (
    <p className={`flex items-center gap-1.5 text-sm ${tone}`}>
      <AlertIcon className="size-4 shrink-0" />
      {text}
    </p>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const color = roleColor(message.role);
  const kind = statusKind(message.content);
  const text = kind ? message.content.replace(/^[⏹⚠️]+\s*/u, '') : message.content;

  return (
    <div className="flex gap-3 px-4 py-3 sm:px-6">
      <Avatar role={message.role} />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-baseline gap-2">
          <span className={`text-sm font-semibold ${color.nameText}`}>{message.role}</span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {formatTime(message.createdAt)}
          </span>
        </div>
        {kind ? (
          <StatusLine kind={kind} text={text} />
        ) : (
          <MessageContent content={message.content} />
        )}
      </div>
    </div>
  );
}

function TypingRow({
  provider,
  cancelling,
  onCancel,
}: {
  provider: string;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const color = roleColor(provider);
  return (
    <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
      <Avatar role={provider} />
      <span className={`text-sm font-semibold ${color.nameText}`}>{provider}</span>
      <span className="flex items-center gap-1" aria-label={`${provider} is replying`}>
        <span className="size-1.5 animate-pulse rounded-full bg-neutral-400 [animation-delay:-0.3s] dark:bg-neutral-500" />
        <span className="size-1.5 animate-pulse rounded-full bg-neutral-400 [animation-delay:-0.15s] dark:bg-neutral-500" />
        <span className="size-1.5 animate-pulse rounded-full bg-neutral-400 dark:bg-neutral-500" />
      </span>
      <button
        type="button"
        onClick={onCancel}
        disabled={cancelling}
        className="ml-auto flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        <StopIcon className="size-3" />
        {cancelling ? 'Stopping…' : 'Stop'}
      </button>
    </div>
  );
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
  }, [chat?.messages.length, sending]);

  // Auto-grow the textarea with content, capped so a long paste doesn't push the
  // send button off-screen — the same behavior every mainstream chat input has.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX).toString()}px`;
  }, [draft]);

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
          ? {
              ...current,
              messages: mergeMessages(current.messages, newMessages),
              runningAttempt: null,
            }
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

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend(event);
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
        <main className="p-6 text-sm text-neutral-500">Loading…</main>
      </>
    );
  }

  return (
    <>
      <Nav current="/chat" />
      <main className="flex h-[calc(100vh-49px)] flex-col bg-white dark:bg-neutral-950">
        <header className="border-b border-neutral-200 dark:border-neutral-800">
          <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-3 sm:px-6">
            {chat.providers.map((provider, index) => {
              const color = roleColor(provider);
              return (
                <span key={provider} className="flex items-center gap-2">
                  {index > 0 && (
                    <span className="text-neutral-300 dark:text-neutral-700">→</span>
                  )}
                  <span className="flex items-center gap-1.5">
                    <Avatar role={provider} size="sm" />
                    <span className={`text-sm font-medium ${color.nameText}`}>{provider}</span>
                  </span>
                </span>
              );
            })}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl">
            {chat.messages.length === 0 && !sending && (
              <div className="flex flex-col items-center gap-1 px-6 py-16 text-center">
                <p className="text-sm text-neutral-500">
                  Say something to start the conversation.
                </p>
                <p className="text-xs text-neutral-400 dark:text-neutral-600">
                  {chat.providers.join(' → ')} will take turns replying, in order.
                </p>
              </div>
            )}
            <div className="flex flex-col divide-y divide-neutral-100 py-2 dark:divide-neutral-900">
              {chat.messages.map((message) => (
                <MessageRow key={message.id} message={message} />
              ))}
              {sending && (
                <TypingRow
                  provider={chat.runningAttempt?.provider ?? chat.providers[0]!}
                  cancelling={cancelling}
                  onCancel={() => void handleCancel()}
                />
              )}
            </div>
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="border-t border-neutral-200 dark:border-neutral-800">
          <form
            onSubmit={(event) => void handleSend(event)}
            className="mx-auto flex max-w-3xl items-end gap-2 px-4 py-4 sm:px-6"
          >
            <textarea
              ref={textareaRef}
              rows={1}
              className="max-h-[200px] flex-1 resize-none rounded-2xl border border-neutral-300 bg-white px-4 py-2.5 text-sm leading-relaxed text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-600 dark:focus:border-neutral-500"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Send a message… (Enter to send, Shift+Enter for a new line)"
              disabled={sending}
            />
            <button
              type="submit"
              disabled={sending || !draft.trim()}
              aria-label="Send"
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition-opacity hover:opacity-90 disabled:opacity-30 dark:bg-white dark:text-neutral-900"
            >
              <SendIcon className="size-4" />
            </button>
          </form>
          {sendError && (
            <p className="mx-auto max-w-3xl px-4 pb-3 text-sm text-red-600 sm:px-6 dark:text-red-400">
              {sendError}
            </p>
          )}
        </div>
      </main>
    </>
  );
}
