/**
 * The session cookie's name and attributes. A constant, not a config value — like
 * `PROXY_BIND_HOST` in `apps/proxy`, this is a security property and not something an
 * operator should be able to loosen by editing `.env`.
 */
export const SESSION_COOKIE_NAME = 'agentmesh_session';

/** 30 days, matching `session.ts`'s server-side TTL — the cookie must not outlive the row. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface CookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
  maxAge: number;
}

/**
 * `secure` is conditional on `NODE_ENV`, everything else is not. `SameSite=Lax` rather
 * than `Strict`: a strict cookie is dropped on top-level navigation from another site,
 * which breaks the flow where a user follows a link into the app and expects to already
 * be signed in. Lax still blocks the cookie on cross-site POSTs, which is what matters
 * for CSRF on the endpoints that mutate state.
 */
export function sessionCookieOptions(nodeEnv: string): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: nodeEnv === 'production',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  };
}
