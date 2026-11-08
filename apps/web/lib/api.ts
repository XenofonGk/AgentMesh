/**
 * The only place the web app talks to the API from. Every call sets
 * `credentials: 'include'` — the session is a cookie the API set (httpOnly, so this
 * code can't read it directly), not a bearer token this code holds and could leak.
 *
 * `NEXT_PUBLIC_API_URL` is baked in at build time (see `next.config.ts`'s comment on
 * `output: 'standalone'` and the Dockerfile's build arg) — it has to be a URL the
 * *browser* can reach, not the `api:3001` DNS name only the compose network resolves.
 */
export const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

export interface Me {
  userId: string;
}

export interface AttemptSummary {
  id: string;
  provider: string;
  status: string;
  costUsd: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  outcome: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunDetail {
  id: string;
  task: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  attempts: AttemptSummary[];
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_URL}${path}`, { ...init, credentials: 'include' });
}

export async function login(email: string, password: string): Promise<boolean> {
  const response = await apiFetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return response.ok;
}

export async function logout(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST' });
}

export async function me(): Promise<Me | null> {
  const response = await apiFetch('/auth/me');
  if (!response.ok) return null;
  return (await response.json()) as Me;
}

export async function startRun(
  task: string,
  providers: string[],
): Promise<{ runId: string }> {
  const response = await apiFetch('/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task, providers }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `failed to start run: ${response.status.toString()}`);
  }
  return (await response.json()) as { runId: string };
}

export async function getRun(runId: string): Promise<RunDetail | null> {
  const response = await apiFetch(`/runs/${runId}`);
  if (!response.ok) return null;
  return (await response.json()) as RunDetail;
}

export interface RunSummary {
  id: string;
  task: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export async function listRuns(before?: string): Promise<RunSummary[]> {
  const qs = before ? `?before=${encodeURIComponent(before)}` : '';
  const response = await apiFetch(`/runs${qs}`);
  if (!response.ok) {
    throw new Error(`failed to list runs: ${response.status.toString()}`);
  }
  const { runs } = (await response.json()) as { runs: RunSummary[] };
  return runs;
}

export async function deleteRun(runId: string): Promise<boolean> {
  const response = await apiFetch(`/runs/${runId}`, { method: 'DELETE' });
  return response.ok;
}

/** 204 on cancelled, `false` if the attempt was already done (409) or gone (404) —
 *  both are fine to treat the same client-side, there's nothing left to cancel. */
export async function cancelAttempt(attemptId: string): Promise<boolean> {
  const response = await apiFetch(`/attempts/${attemptId}/cancel`, { method: 'POST' });
  return response.ok;
}

/** Forks a finished Run attempt into a new single-provider Chat you can keep talking
 *  to — see `continueAttemptAsChat` on the server for why this is a fork, not a second
 *  continuation mechanism. `null` if the attempt isn't owned by you or isn't a
 *  succeeded Run attempt (still running, failed, or already a Chat attempt). */
export async function continueAttempt(attemptId: string): Promise<{ chatId: string } | null> {
  const response = await apiFetch(`/attempts/${attemptId}/continue`, { method: 'POST' });
  if (!response.ok) return null;
  return (await response.json()) as { chatId: string };
}

/**
 * `EventSource` over `fetch` for this one case: it has a native reconnect-with-backoff
 * and a `withCredentials` flag that sends the session cookie cross-origin, which is
 * exactly the SSE contract `apps/api/src/events/routes.ts` speaks — no bespoke
 * reconnect/backoff logic to get subtly wrong here.
 */
export function subscribeToAttempt(attemptId: string): EventSource {
  return new EventSource(`${API_URL}/attempts/${attemptId}/events`, {
    withCredentials: true,
  });
}

export interface SkillSummary {
  name: string;
  description: string | null;
  valid: boolean;
  error?: string;
}

/** List every skill under `AGENTMESH_SKILLS_DIR`, valid or not. */
export async function listSkills(): Promise<SkillSummary[]> {
  const response = await apiFetch('/skills');
  if (!response.ok) {
    throw new Error(`failed to list skills: ${response.status.toString()}`);
  }
  const { skills } = (await response.json()) as { skills: SkillSummary[] };
  return skills;
}

/** Fetch a single skill's raw `SKILL.md` content, or `null` if it doesn't exist. */
export async function getSkill(
  name: string,
): Promise<{ name: string; content: string } | null> {
  const response = await apiFetch(`/skills/${encodeURIComponent(name)}`);
  if (!response.ok) return null;
  return (await response.json()) as { name: string; content: string };
}

/**
 * Create or update a skill from raw `SKILL.md` text. The server re-validates with
 * `parseSkillMarkdown` regardless of any client-side check — see
 * `apps/api/src/skills/routes.ts`. Returns a typed error on rejection rather than
 * throwing, so the editor can show it inline.
 */
export async function saveSkill(
  name: string,
  content: string,
): Promise<{ ok: true } | { ok: false; error: string; message?: string }> {
  const response = await apiFetch(`/skills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    return {
      ok: false,
      error: body.error ?? `http_${response.status.toString()}`,
      ...(body.message !== undefined ? { message: body.message } : {}),
    };
  }
  return { ok: true };
}

export async function deleteSkill(name: string): Promise<boolean> {
  const response = await apiFetch(`/skills/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  return response.ok;
}

export interface SkillVersion {
  id: string;
  skillName: string;
  version: number;
  content: string;
  status: 'proposed' | 'active' | 'rejected';
  createdBy: string | null;
  createdAt: string;
  activatedAt: string | null;
  evalResult: unknown;
}

/** VERSION history for a skill, newest first. */
export async function listSkillVersions(name: string): Promise<SkillVersion[]> {
  const response = await apiFetch(`/skills/${encodeURIComponent(name)}/versions`);
  if (!response.ok) {
    throw new Error(`failed to list skill versions: ${response.status.toString()}`);
  }
  const { versions } = (await response.json()) as { versions: SkillVersion[] };
  return versions;
}

/** PROPOSE: records a new version without activating it — never touches the live file. */
export async function proposeSkillVersion(
  name: string,
  content: string,
): Promise<{ ok: true } | { ok: false; error: string; message?: string }> {
  const response = await apiFetch(`/skills/${encodeURIComponent(name)}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    return {
      ok: false,
      error: body.error ?? `http_${response.status.toString()}`,
      ...(body.message !== undefined ? { message: body.message } : {}),
    };
  }
  return { ok: true };
}

/** GATE: promotes a `'proposed'` version to `'active'`, writing it to the live file. */
export async function activateSkillVersion(
  name: string,
  version: number,
): Promise<boolean> {
  const response = await apiFetch(
    `/skills/${encodeURIComponent(name)}/versions/${version.toString()}/activate`,
    { method: 'POST' },
  );
  return response.ok;
}

/** GATE: rejects a `'proposed'` version. Never touches the live file. */
export async function rejectSkillVersion(
  name: string,
  version: number,
): Promise<boolean> {
  const response = await apiFetch(
    `/skills/${encodeURIComponent(name)}/versions/${version.toString()}/reject`,
    { method: 'POST' },
  );
  return response.ok;
}

// --- Credentials ----------------------------------------------------------------

export interface CredentialSummary {
  provider: string;
  keyVersion: number;
  createdAt: string;
}

export async function listCredentials(): Promise<CredentialSummary[]> {
  const response = await apiFetch('/credentials');
  if (!response.ok) {
    throw new Error(`failed to list credentials: ${response.status.toString()}`);
  }
  const { credentials } = (await response.json()) as {
    credentials: CredentialSummary[];
  };
  return credentials;
}

export async function putCredential(
  provider: string,
  apiKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await apiFetch(`/credentials/${encodeURIComponent(provider)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `http_${response.status.toString()}` };
  }
  return { ok: true };
}

export async function deleteCredential(provider: string): Promise<boolean> {
  const response = await apiFetch(`/credentials/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
  });
  return response.ok;
}

// --- Chat (round-robin relay, continuable) ---------------------------------------

export interface ChatSummary {
  id: string;
  providers: string[];
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  turn: number;
  role: string;
  content: string;
  createdAt: string;
}

export interface ChatDetail extends ChatSummary {
  messages: ChatMessage[];
  /** The attempt currently running this chat's turn, if any — lets the UI show
   *  which provider is replying right now and offer a Stop button, even though
   *  `sendChatMessage` below doesn't return until the whole round is done. */
  runningAttempt: { id: string; provider: string } | null;
}

async function apiError(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  return new Error(body.message ?? fallback);
}

export async function createChat(providers: string[]): Promise<{ chatId: string }> {
  const response = await apiFetch('/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providers }),
  });
  if (!response.ok) {
    throw await apiError(response, `failed to create chat: ${response.status.toString()}`);
  }
  return (await response.json()) as { chatId: string };
}

export async function listChats(before?: string): Promise<ChatSummary[]> {
  const qs = before ? `?before=${encodeURIComponent(before)}` : '';
  const response = await apiFetch(`/chats${qs}`);
  if (!response.ok) {
    throw new Error(`failed to list chats: ${response.status.toString()}`);
  }
  const { chats } = (await response.json()) as { chats: ChatSummary[] };
  return chats;
}

export async function deleteChat(chatId: string): Promise<boolean> {
  const response = await apiFetch(`/chats/${chatId}`, { method: 'DELETE' });
  return response.ok;
}

export async function getChat(chatId: string): Promise<ChatDetail | null> {
  const response = await apiFetch(`/chats/${chatId}`);
  if (!response.ok) return null;
  return (await response.json()) as ChatDetail;
}

/** Sends a message and waits for every provider in the chat to reply — see
 *  `chat-service.ts`'s module doc on the server for why this is a plain await, not
 *  SSE. Can take a while: each provider is a real container, run in sequence. */
export async function sendChatMessage(
  chatId: string,
  content: string,
): Promise<ChatMessage[]> {
  const response = await apiFetch(`/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    throw await apiError(response, `failed to send message: ${response.status.toString()}`);
  }
  const { messages } = (await response.json()) as { messages: ChatMessage[] };
  return messages;
}

// --- Reviews --------------------------------------------------------------------

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

/** Approve or reject a `file_edit` event — Phase 3's diff-review UI. */
export async function reviewFileEdit(
  attemptId: string,
  eventId: string,
  status: Extract<ReviewStatus, 'approved' | 'rejected'>,
): Promise<boolean> {
  const response = await apiFetch(`/attempts/${attemptId}/events/${eventId}/review`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return response.ok;
}
