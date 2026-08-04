/**
 * The Gemini `ModelAdapter` — see the `adapter-authoring` skill before touching this
 * file. Unlike `claudeAdapter`, this is a plain `fetch` against the Generative
 * Language API through the proxy, not a subprocess wrapper: Gemini has no equivalent
 * of the Claude Agent SDK's CLI that edits files and runs tools on its own, so there
 * is nothing here for a subprocess to wrap.
 *
 * ## Not agentic, on purpose — adapter-authoring rule 3, "degrade honestly"
 *
 * `capabilities.agentic` and `.toolUse` are both `false`. A real agentic Gemini
 * adapter needs its own tool-execution loop — Read/Write/Edit/Bash implemented and
 * sandboxed by this codebase, not borrowed from an SDK — which is a feature on its
 * own, not something to fake inside a 100-line adapter file. This adapter is a
 * legitimate, honest thing on its own: a plain-chat comparison point in a bake-off,
 * exactly the "one task → four models → a side-by-side" PLAN.md Phase 3 describes,
 * just not one of the four that edits your repo.
 *
 * ## Not streaming, on purpose — same rule, different capability
 *
 * `capabilities.streaming` is `false` too. Gemini's actual streaming endpoint
 * (`streamGenerateContent?alt=sse`) needs a query string, and `apps/proxy`'s
 * forwarding path (`server.ts`) never forwards one — deliberately: the proxy's whole
 * design is "the runner names nothing about the request beyond a fixed, pinned
 * (provider, path)," and a query string is one more thing a compromised runner could
 * otherwise use to smuggle intent to the upstream. Widening the proxy to forward query
 * strings is a proxy-design change (CLAUDE.md: ask before making one), so this adapter
 * uses the plain `generateContent` endpoint instead — one blocking call, one response,
 * emitted as a single `message_delta` rather than synthetically chopped into fake
 * chunks. A capability declared `false` and genuinely absent beats one simulated to
 * look like the real thing.
 *
 * ## Run token — same shape as Claude's, simpler mechanism
 *
 * The run token is sent as `x-goog-api-key`, Gemini's own documented auth header —
 * `apps/proxy/src/providers.ts` maps that provider to that header, and the proxy
 * swaps it for the real credential before forwarding, exactly as it does for Claude.
 * No subprocess env trick needed here since this adapter calls `fetch` directly.
 */
import type {
  AdapterCapabilities,
  AgentEvent,
  ModelAdapter,
  RunContext,
  RunInput,
} from '@agentmesh/core';

export const GEMINI_CAPABILITIES: AdapterCapabilities = {
  agentic: false,
  streaming: false,
  toolUse: false,
  // Gemini 2.0 Flash's context window.
  maxContextTokens: 1_048_576,
};

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string };
}

export const geminiAdapter: ModelAdapter = {
  id: 'gemini',
  capabilities: GEMINI_CAPABILITIES,
  // Real credential, unlike Claude's null-because-it's-a-run-token case: nothing here
  // substitutes a run token into a header the way the subprocess-based adapter does,
  // so there is genuinely no schema to validate a caller-provided key against yet.
  // Still resolved through the proxy at request time, same invariant-6 guarantee.
  credentialSchema: null,

  async *run(input: RunInput, ctx: RunContext): AsyncIterable<AgentEvent> {
    const base = {
      attemptId: ctx.attemptId,
      provider: 'gemini',
      timestamp: new Date().toISOString(),
    };

    let response: Response;
    try {
      response = await fetch(
        `${ctx.proxyUrl}/providers/gemini/v1beta/models/gemini-2.0-flash:generateContent`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': ctx.runToken,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: input.task }] }],
            ...(input.systemPrompt && {
              systemInstruction: { parts: [{ text: input.systemPrompt }] },
            }),
          }),
          ...(ctx.signal && { signal: ctx.signal }),
        },
      );
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

    const body = (await response
      .json()
      .catch(() => null)) as GenerateContentResponse | null;

    if (!response.ok || body === null) {
      yield {
        ...base,
        type: 'error',
        message:
          body?.error?.message ?? `gemini request failed: ${response.status.toString()}`,
        recoverable: false,
      };
      yield { ...base, type: 'done', outcome: 'failed', usage: null };
      return;
    }

    const text =
      body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    if (text.length > 0) {
      yield { ...base, type: 'message_delta', role: 'assistant', text };
    }

    yield {
      ...base,
      type: 'done',
      outcome: 'succeeded',
      usage: {
        inputTokens: body.usageMetadata?.promptTokenCount ?? null,
        outputTokens: body.usageMetadata?.candidatesTokenCount ?? null,
        // Gemini's API doesn't return a cost figure — estimateCost would need a
        // hardcoded per-model price table, which is out of scope here (adapter-authoring:
        // null is an honest answer, not a gap to paper over with a guessed number).
        costUsd: null,
        latencyMs: null,
      },
    };
  },
};
