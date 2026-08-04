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
    throw new Error(`failed to start run: ${response.status.toString()}`);
  }
  return (await response.json()) as { runId: string };
}

export async function getRun(runId: string): Promise<RunDetail | null> {
  const response = await apiFetch(`/runs/${runId}`);
  if (!response.ok) return null;
  return (await response.json()) as RunDetail;
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
