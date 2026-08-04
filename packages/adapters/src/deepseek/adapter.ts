/**
 * The DeepSeek `ModelAdapter` — see the `adapter-authoring` skill before touching this
 * file. Like `geminiAdapter`, a plain `fetch` against the proxy, not a subprocess
 * wrapper: DeepSeek's API is OpenAI-compatible chat completions, not an agent — same
 * "degrade honestly" reasoning as Gemini's adapter for why `capabilities.agentic` and
 * `.toolUse` are both `false`. No tool-execution loop is faked here either.
 *
 * ## This one really does stream — unlike Gemini's adapter
 *
 * OpenAI-compatible streaming is a `"stream": true` field in the JSON request body,
 * not a query string. `apps/proxy`'s forwarding path relays the request body and the
 * response body byte-for-byte without inspecting either (`server.ts`'s own doc
 * comment: "no SSE parsing here — that is the adapter's job, not the proxy's"), so
 * nothing about the proxy's SSRF-hardening needed to change to support this — the
 * constraint that ruled out real streaming for Gemini (a query string the proxy never
 * forwards) simply doesn't apply here. `capabilities.streaming` is `true`, honestly.
 *
 * ## Run token via Authorization: Bearer — see providers.ts's authValuePrefix
 *
 * DeepSeek's auth header is `Authorization: Bearer <key>`, not a bare value like
 * Claude's `x-api-key` or Gemini's `x-goog-api-key`. `apps/proxy/src/providers.ts`
 * added `authValuePrefix` for exactly this — the run token still travels in the real
 * auth header (same reasoning as every other adapter), just with `'Bearer '` glued on
 * both when this adapter sends it and when the proxy re-attaches the real secret.
 */
import type {
  AdapterCapabilities,
  AgentEvent,
  ModelAdapter,
  RunContext,
  RunInput,
} from '@agentmesh/core';

export const DEEPSEEK_CAPABILITIES: AdapterCapabilities = {
  agentic: false,
  streaming: true,
  toolUse: false,
  maxContextTokens: 64_000,
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

export const deepseekAdapter: ModelAdapter = {
  id: 'deepseek',
  capabilities: DEEPSEEK_CAPABILITIES,
  credentialSchema: null,

  async *run(input: RunInput, ctx: RunContext): AsyncIterable<AgentEvent> {
    const base = {
      attemptId: ctx.attemptId,
      provider: 'deepseek',
      timestamp: new Date().toISOString(),
    };

    let response: Response;
    try {
      response = await fetch(`${ctx.proxyUrl}/providers/deepseek/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ctx.runToken}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: input.task }],
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
          `deepseek request failed: ${response.status.toString()}`,
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
