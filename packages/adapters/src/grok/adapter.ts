/**
 * The Grok (x.ai) `ModelAdapter` — see the `adapter-authoring` skill before touching
 * this file. Mirrors `deepseekAdapter` almost exactly: x.ai's API is also OpenAI-
 * compatible chat completions, not an agent — same "degrade honestly" reasoning for why
 * `capabilities.agentic` and `.toolUse` are both `false`. No tool-execution loop is
 * faked here either.
 *
 * ## This one really does stream — same reasoning as DeepSeek's adapter
 *
 * OpenAI-compatible streaming is a `"stream": true` field in the JSON request body, not
 * a query string, so the proxy's byte-for-byte relay needs no changes to support it —
 * the constraint that ruled out real streaming for Gemini (a query string the proxy
 * never forwards) doesn't apply here. `capabilities.streaming` is `true`, honestly.
 *
 * ## Run token via Authorization: Bearer — see providers.ts's authValuePrefix
 *
 * x.ai's auth header is `Authorization: Bearer <key>`, so this reuses the same
 * `authValuePrefix` mechanism `apps/proxy/src/providers.ts` added for DeepSeek — the
 * run token still travels in the real auth header, just with `'Bearer '` glued on both
 * when this adapter sends it and when the proxy re-attaches the real secret.
 */
import type {
  AdapterCapabilities,
  AgentEvent,
  ModelAdapter,
  RunContext,
  RunInput,
} from '@agentmesh/core';

export const GROK_CAPABILITIES: AdapterCapabilities = {
  agentic: false,
  streaming: true,
  toolUse: false,
  maxContextTokens: 131_072,
};

interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** Splits an SSE byte stream into raw `data: ...` payload strings, `[DONE]` included. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith('data:')) {
          yield line.slice('data:'.length).trim();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const grokAdapter: ModelAdapter = {
  id: 'grok',
  capabilities: GROK_CAPABILITIES,
  credentialSchema: null,

  async *run(input: RunInput, ctx: RunContext): AsyncIterable<AgentEvent> {
    const base = {
      attemptId: ctx.attemptId,
      provider: 'grok',
      timestamp: new Date().toISOString(),
    };

    let response: Response;
    try {
      response = await fetch(`${ctx.proxyUrl}/providers/grok/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ctx.runToken}`,
        },
        body: JSON.stringify({
          model: 'grok-3',
          messages: [
            ...(input.systemPrompt
              ? [{ role: 'system', content: input.systemPrompt }]
              : []),
            { role: 'user', content: input.task },
          ],
          stream: true,
          stream_options: { include_usage: true },
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
        .catch(() => null)) as ChatCompletionChunk | null;
      yield {
        ...base,
        type: 'error',
        message:
          errorBody?.error?.message ??
          `grok request failed: ${response.status.toString()}`,
        recoverable: false,
      };
      yield { ...base, type: 'done', outcome: 'failed', usage: null };
      return;
    }

    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let sawError = false;

    for await (const raw of sseData(response.body)) {
      if (raw === '[DONE]') break;

      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(raw) as ChatCompletionChunk;
      } catch {
        continue;
      }

      const text = chunk.choices?.[0]?.delta?.content;
      if (text) {
        yield { ...base, type: 'message_delta', role: 'assistant', text };
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? null;
        outputTokens = chunk.usage.completion_tokens ?? null;
      }
      if (chunk.error) {
        sawError = true;
        yield {
          ...base,
          type: 'error',
          message: chunk.error.message ?? 'unknown error',
          recoverable: false,
        };
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
