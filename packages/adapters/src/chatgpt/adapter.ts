/**
 * The OpenAI `ModelAdapter` — see the `adapter-authoring` skill before touching this
 * file. Plain Chat Completions, not the Codex CLI: OpenAI's Chat Completions API is
 * OpenAI-compatible chat completions by definition, not an agent — same "degrade
 * honestly" reasoning as the Gemini/Grok/DeepSeek adapters for why
 * `capabilities.agentic` and `.toolUse` are both `false`. No tool-execution loop is
 * faked here. A separate, agentic adapter wrapping OpenAI's actual Codex CLI (like
 * `claudeAdapter` wraps the Claude Agent SDK subprocess) is a deliberately distinct,
 * larger follow-up — this file is not it, and `apps/broker/src/allowlist.ts` already
 * reserves a separate `codex` image name for when that lands.
 *
 * ## Streams like Grok/DeepSeek — same OpenAI-compatible shape
 *
 * `"stream": true` in the JSON request body, not a query string, so the proxy's
 * byte-for-byte relay needs no changes — same reasoning as the Grok/DeepSeek adapters.
 * `capabilities.streaming` is `true`, honestly.
 *
 * ## Run token via Authorization: Bearer — see providers.ts's authValuePrefix
 *
 * OpenAI's auth header is `Authorization: Bearer <key>`, the same mechanism DeepSeek
 * and Grok already use — the run token travels in the real auth header, with
 * `'Bearer '` glued on both when this adapter sends it and when the proxy re-attaches
 * the real secret.
 *
 * ## Model id — verify before trusting
 *
 * `gpt-5-chat-latest` is OpenAI's own "-latest" alias pattern, specifically meant not
 * to go stale the way a dated snapshot id would — this session already hit exactly
 * that failure mode with Gemini's hardcoded `gemini-2.0-flash` (deprecated, 404). If
 * this adapter starts failing with a 404/"model not found", check
 * platform.openai.com/docs/models for the current alias before assuming it's a vault
 * credential problem.
 */
import type {
  AdapterCapabilities,
  AgentEvent,
  ModelAdapter,
  RunContext,
  RunInput,
} from '@agentmesh/core';

export const CHATGPT_CAPABILITIES: AdapterCapabilities = {
  agentic: false,
  streaming: true,
  toolUse: false,
  // gpt-5-chat-latest's context window.
  maxContextTokens: 128_000,
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

export const chatgptAdapter: ModelAdapter = {
  id: 'chatgpt',
  capabilities: CHATGPT_CAPABILITIES,
  credentialSchema: null,

  async *run(input: RunInput, ctx: RunContext): AsyncIterable<AgentEvent> {
    const base = {
      attemptId: ctx.attemptId,
      provider: 'chatgpt',
      timestamp: new Date().toISOString(),
    };

    let response: Response;
    try {
      response = await fetch(`${ctx.proxyUrl}/providers/chatgpt/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ctx.runToken}`,
        },
        body: JSON.stringify({
          model: 'gpt-5-chat-latest',
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
      // Same reasoning as the grok/deepseek adapters' twin of this block: fall back to
      // a truncated raw-body snippet, not a bare status code, when the response doesn't
      // match the expected `{error:{message}}` shape — a failure should be diagnosable
      // from the chat/run UI without digging into logs.
      const rawText = await response.text().catch(() => '');
      let errorBody: ChatCompletionChunk | null = null;
      try {
        errorBody = JSON.parse(rawText) as ChatCompletionChunk;
      } catch {
        errorBody = null;
      }
      yield {
        ...base,
        type: 'error',
        message:
          errorBody?.error?.message ??
          `chatgpt request failed: ${response.status.toString()}${rawText ? ` — ${rawText.slice(0, 300)}` : ''}`,
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
