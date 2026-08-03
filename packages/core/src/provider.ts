/**
 * Provider resolution — the single seam every credential lookup goes through.
 *
 * ## Why this exists before there is anything to resolve
 *
 * The `credentials` table is unique on `(user_id, provider)`, so today "the user's
 * Claude key" is a total function. That constraint is right for now, but the cost of
 * relaxing it later is not in the schema — adding a `label` column and reshaping a
 * unique index is a purely additive migration that never decrypts a byte. The cost is
 * in call sites that assumed uniqueness. So there is exactly one of them, here, and it
 * takes a selector rather than a bare provider id: adding `label` later widens the
 * selector and every existing caller keeps compiling.
 *
 * ## Two things, not one
 *
 * A stored provider setup conflates a **secret** with a **configuration**, and they
 * have opposite handling rules:
 *
 *   secret         ciphertext; never displayed, never logged, never leaves the proxy
 *   configuration  base URL, model list, label; displayed freely, edited in the UI
 *
 * They are not merely different columns — they have different cardinalities. Ollama
 * needs a configuration and no secret at all, which `ModelAdapter.credentialSchema:
 * ZodSchema | null` (PLAN.md §3) already concedes. A user with a local Ollama box and a
 * remote GPU box has two configurations and zero credentials, so multi-instance belongs
 * on the configuration side, where it costs nothing.
 *
 * That is why `secret` below is nullable and separate from `config`, and why the
 * eventual `provider_configs` table (Phase 2, when the Ollama adapter is the thing that
 * needs it) can be added without touching a row of ciphertext.
 *
 * ## The secret never travels as a value
 *
 * `resolve()` returns a {@link SecretRef}, not a key. Invariant 4 says a decrypted key
 * exists only within one request's scope in proxy memory; a resolver that returned a
 * plaintext string would put one in orchestrator scope, in an object that gets passed
 * around, retained, and eventually logged by someone who reasonably assumed it was
 * metadata. Only the proxy exchanges a `SecretRef` for header bytes, and only for the
 * duration of the request it is forwarding.
 *
 * ## A SecretRef is not a capability
 *
 * It is server-side bookkeeping, never something a runner presents. A ref that could be
 * redeemed by whoever holds it would let a compromised runner ask for another user's
 * credential, and refs travel through logs and run records. The runner presents a run
 * token instead and the proxy derives the ref itself — see `apps/proxy/src/run-token.ts`.
 * Nothing outside the API process should ever see one of these.
 */
import type { Result } from './result.js';

/** Adapter id: 'claude' | 'gemini' | 'deepseek' | 'grok' | 'ollama' | … */
export type ProviderId = string;

/**
 * Which provider setup a caller wants. An object rather than a bare `ProviderId` so
 * that adding `label` (or `configId`) later does not touch a single call site.
 */
export interface ProviderSelector {
  provider: ProviderId;
}

/**
 * Non-secret provider settings. Safe to return over the API and render in the UI —
 * nothing here is confidential, by construction.
 */
export interface ProviderConfig {
  provider: ProviderId;
  /** Operator-facing name. Distinct instances differ here, e.g. 'laptop' vs 'gpu-box'. */
  label: string;
  /** Non-default endpoint: an Ollama host, a gateway, a self-hosted proxy. */
  baseUrl: string | null;
}

/**
 * A handle to encrypted credential material. Deliberately carries no key bytes — see
 * the header note. `keyVersion` is the `user_keys.generation` that encrypted it, which
 * is what lets a rotation tell readable rows from stale ones.
 */
export interface SecretRef {
  credentialId: string;
  keyVersion: number;
}

/**
 * A provider ready to be run. `secret` is null for providers that need none — which is
 * a normal outcome, not a failure.
 */
export interface ResolvedProvider {
  userId: string;
  config: ProviderConfig;
  secret: SecretRef | null;
}

/** Expected failures. Typed returns, not throws (CLAUDE.md → Conventions). */
export type ResolutionFailure =
  | { kind: 'not_configured'; provider: ProviderId }
  | { kind: 'user_disabled'; userId: string }
  /** Configured, but the stored secret cannot be read under any current key. */
  | { kind: 'secret_unreadable'; provider: ProviderId; keyVersion: number };

/**
 * Every credential lookup in the codebase goes through this. If you find yourself
 * querying the `credentials` table anywhere else, that is the bug this interface exists
 * to prevent.
 */
export interface ProviderResolver {
  resolve(
    userId: string,
    selector: ProviderSelector,
  ): Promise<Result<ResolvedProvider, ResolutionFailure>>;
}
