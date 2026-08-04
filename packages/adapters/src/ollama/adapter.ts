/**
 * The Ollama `ModelAdapter` — see the `adapter-authoring` skill before touching this
 * file. This is PLAN.md's "no credential path — good control case": `credentialSchema`
 * is `null`, not an empty schema, because there genuinely is no secret. See
 * `packages/core/src/provider.ts`'s module doc for why that's a real, supported outcome
 * rather than a gap — a local/LAN Ollama box has a *configuration* (its base URL) and
 * zero credentials.
 *
 * ## Still goes through the proxy, even with nothing to inject
 *
 * Invariant 3 says runner containers have no default outbound internet access — they
 * sit on the `internal` Docker network, which has no route anywhere (compose.yaml).
 * That is true regardless of whether a request carries a secret, so "no credential"
 * does not mean "runner talks to Ollama directly" — it would need real egress to do
 * that, which is exactly the restriction invariant 3 exists to avoid loosening per
 * provider. Instead this adapter calls `ctx.proxyUrl` exactly like every other adapter;
 * `apps/proxy/src/providers.ts` carries an `ollama` route with `secretRequired: false`,
 * so `apps/proxy/src/server.ts` forwards the request without ever calling
 * `vault.useCredential` for it. The proxy is still the only process with real egress
 * (`default` network in compose.yaml) and still the SSRF guard (fixed, code-defined
 * origin/path allowlist) — Ollama just doesn't need the secret-injection half of what
 * it does.
 *
 * ## NDJSON, not SSE — the one real parsing difference from grok/deepseek
 *
 * Ollama's `/api/chat` streams newline-delimited JSON objects, not `data: ...` SSE
 * frames — no `[DONE]` sentinel either; the stream simply ends, and the final object
 * carries `"done": true` plus Ollama's own duration/token-count fields. That's a
 * genuinely different wire format from the OpenAI-compatible adapters, so this file
 * has its own line-splitter (`ndjson`) instead of reusing an SSE one.
 *
 * ## Model is hardcoded, like grok's `grok-3` / deepseek's `deepseek-chat`
 *
 * There's no per-run model selection yet anywhere in the adapter layer, and threading
 * one through would be a `RunInput`/UI change out of scope here. `DEFAULT_MODEL` is the
 * one substantive Ollama-specific caveat: the operator must have pulled it (`ollama
 * pull llama3.1`) on whatever box `OLLAMA_URL` points at, or every run fails with a
 * `model not found` error event — that's an honest, recoverable-by-the-operator
 * failure, not a bug in this adapter.
 *
 * ## Capabilities: matched to grok/deepseek's scope, not to what Ollama could do
 *
 * Ollama's `/api/chat` does support tool calls for some models, but tool-use
 * reliability is wildly model-dependent (the adapter-authoring skill's own warning:
 * "declare `toolUse` per-model, not per-provider"). Doing that honestly needs a
 * per-model capability table this codebase doesn't have yet, so — matching the scope of
 * the other plain-HTTP-streaming adapters — this stays a plain streaming chat adapter:
 * `agentic: false`, `toolUse: false`.
 */
import type {
  AdapterCapabilities,
  AgentEvent,
  ModelAdapter,
  RunContext,
  RunInput,
} from '@agentmesh/core';

export const OLLAMA_CAPABILITIES: AdapterCapabilities = {
  agentic: false,
  streaming: true,
  toolUse: false,
  // Conservative floor, not a promise — real context windows vary enormously by model
  // (an operator's local Llama build vs. a quantized 8k checkpoint). See module doc.
  maxContextTokens: 8_192,
};

/** See the module doc's "Model is hardcoded" section. */
const DEFAULT_MODEL = 'llama3.1';

interface OllamaChatChunk {
  message?: { role?: string; content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Splits an NDJSON byte stream into parsed line objects — see the module doc. */
async function* ndjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OllamaChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line === '') continue;
        try {
          yield JSON.parse(line) as OllamaChatChunk;
        } catch {
          // A malformed line is dropped, not fatal — same "degrade honestly, don't
          // throw" reasoning as every other adapter's error handling.
          continue;
        }
      }
    }
    const trailing = buffer.trim();
    if (trailing !== '') {
      try {
        yield JSON.parse(trailing) as OllamaChatChunk;
      } catch {
        // ignored — see above
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const ollamaAdapter: ModelAdapter = {
  id: 'ollama',
  capabilities: OLLAMA_CAPABILITIES,
  // No key is needed at all — see the module doc's opening paragraph. This is the one
  // adapter where `null` here is load-bearing: the proxy route it calls into
  // (`apps/proxy/src/providers.ts`, `secretRequired: false`) is keyed off exactly this
  // fact, not a coincidence between two files that happen to agree.
  credentialSchema: null,

  async *run(input: RunInput, ctx: RunContext): AsyncIterable<AgentEvent> {
    const base = {
      attemptId: ctx.attemptId,
      provider: 'ollama',
      timestamp: new Date().toISOString(),
    };

    let response: Response;
    try {
      response = await fetch(`${ctx.proxyUrl}/providers/ollama/api/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Rule 2 of adapter-authoring: never read a credential. This is not one —
          // there is no Ollama secret to send — but the run token still travels in the
          // real auth header slot, same reasoning as every other adapter, so the proxy
          // can identify the grant and enforce `grantPermits(grant, 'ollama')` even
          // though it injects nothing back into this header.
          authorization: `Bearer ${ctx.runToken}`,
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages: [{ role: 'user', content: input.task }],
          stream: true,
        }),
        ...(ctx.signal && { signal: ctx.signal }),
      });
    } catch (error) {
      yield {
        ...base,
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        recoverable: false,
      };
      yield { ...base, type: 'done', outcome: 'failed', usage: null };
      return;
    }

    if (!response.ok || response.body === null) {
      const errorBody = (await response
        .json()
        .catch(() => null)) as OllamaChatChunk | null;
      yield {
        ...base,
        type: 'error',
        message:
          errorBody?.error ?? `ollama request failed: ${response.status.toString()}`,
        recoverable: false,
      };
      yield { ...base, type: 'done', outcome: 'failed', usage: null };
      return;
    }

    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let sawError = false;

    for await (const chunk of ndjson(response.body)) {
      if (chunk.error) {
        sawError = true;
        yield { ...base, type: 'error', message: chunk.error, recoverable: false };
        continue;
      }

      const text = chunk.message?.content;
      if (text) {
        yield { ...base, type: 'message_delta', role: 'assistant', text };
      }

      if (chunk.done) {
        inputTokens = chunk.prompt_eval_count ?? null;
        outputTokens = chunk.eval_count ?? null;
      }
    }

    yield {
      ...base,
      type: 'done',
      outcome: sawError ? 'failed' : 'succeeded',
      usage: { inputTokens, outputTokens, costUsd: null, latencyMs: null },
    };
  },
};
