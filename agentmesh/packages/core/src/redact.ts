/**
 * Redaction helper. Nothing that could carry a credential may be logged directly —
 * every log path routes its payload through `redact()` first (invariant 1, SECURITY.md).
 *
 * Two independent defenses, because either alone is easy to slip past:
 *   1. Key-name matching — anything that *looks* like a secret field is dropped.
 *   2. Value-shape matching — known credential formats are dropped wherever they appear,
 *      including inside free-text strings such as error messages and stack traces.
 */

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY =
  /(api[-_]?key|secret|token|password|passwd|credential|authorization|auth|cookie|session|private[-_]?key|dek|kek)/i;

/** Known provider credential shapes and generic bearer tokens. */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / DeepSeek style
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\bAIza[A-Za-z0-9_-]{20,}/g, // Google
  /\bxai-[A-Za-z0-9_-]{16,}/g, // xAI / Grok
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const MAX_DEPTH = 8;

function redactString(input: string): string {
  let out = input;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED;

  const obj = value as object;
  if (seen.has(obj)) return '[Circular]';
  seen.add(obj);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack === undefined ? undefined : redactString(value.stack),
    };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item, depth + 1, seen);
  }
  return out;
}

/**
 * Returns a structurally-similar copy of `value` with anything credential-shaped removed.
 * Safe to call on arbitrary input, including cyclic objects and Errors.
 */
export function redact<T>(value: T): unknown {
  return redactValue(value, 0, new WeakSet<object>());
}
