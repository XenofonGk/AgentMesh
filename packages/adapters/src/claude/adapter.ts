/**
 * The Claude `ModelAdapter` — see the `adapter-authoring` skill before touching this
 * file. Wraps `@anthropic-ai/claude-agent-sdk`'s `query()`, which spawns the `claude`
 * CLI as a subprocess and talks to it over stdio; it is not an in-process HTTP client.
 *
 * ## Getting the run token to the CLI without ever holding a credential
 *
 * The CLI only knows how to send a value from `ANTHROPIC_API_KEY` (or an
 * `apiKeyHelper` script) in the `x-api-key` header, pointed at `ANTHROPIC_BASE_URL`.
 * There is no separate "send this bespoke header" mechanism — confirmed by reading
 * `sdk.d.ts` rather than guessing. So `ctx.runToken` is set as `ANTHROPIC_API_KEY` and
 * `ctx.proxyUrl + '/providers/claude'` as `ANTHROPIC_BASE_URL`: the subprocess believes
 * it holds a credential, but the value is an opaque, revocable run token, and
 * `apps/proxy` (see `headers.ts`'s module doc) is what turns that into a real secret —
 * the CLI process itself never sees one. `env` on `Options` *replaces* the subprocess
 * environment rather than merging with it, so nothing else from this process's own env
 * (which also never holds a credential — invariant 6) leaks into the subprocess either.
 *
 * ## Permission mode
 *
 * Runs with `permissionMode: 'bypassPermissions'`. This is not a shortcut: there is no
 * human on the other end of a headless container to answer a permission prompt, and the
 * isolation boundary this depends on is the sandbox itself (`DockerSandboxProvider`
 * — read-only rootfs, dropped capabilities, non-root, no default network), not
 * per-tool-call confirmation. `allowDangerouslySkipPermissions: true` is required by the
 * SDK to accept this and is set for the same reason, not accidentally.
 *
 * ## Lossy / ambiguous mappings — adapter-authoring step 2
 *
 * - `file_edit` is synthesized from `Edit`/`Write`/`MultiEdit` tool_use blocks, not a
 *   native SDK event. `diff` is best-effort (the tool's own input, not a computed
 *   unified diff) — good enough for the transcript UI to show "this file changed and
 *   with what content," not a precise line-level diff yet.
 * - Token/cost accounting only comes from the final `result` message. Mid-run `done`
 *   events are never emitted — there is exactly one per `run()` call, at the end.
 * - `thinking` blocks are only mapped when the stream genuinely labels a delta
 *   `thinking_delta` — never inferred from prose that merely sounds like reasoning.
 */
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentEvent,
  AdapterCapabilities,
  ModelAdapter,
  RunContext,
  RunInput,
} from '@agentmesh/core';

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

export const CLAUDE_CAPABILITIES: AdapterCapabilities = {
  agentic: true,
  streaming: true,
  toolUse: true,
  // Sonnet's current context window. Revisit when the adapter exposes model choice.
  maxContextTokens: 200_000,
};

export const claudeAdapter: ModelAdapter = {
  id: 'claude',
  capabilities: CLAUDE_CAPABILITIES,
  // The API key travels as a run token, never a real credential — see the module doc.
  // Still not `null`: a caller-provided credential is meaningless here (the sandboxed
  // subprocess never sees one), but that's a statement about transport, not about
  // whether Claude needs a key at all — it does, which is what `credentialSchema` is
  // actually asking. `null` is reserved for genuinely credential-free providers
  // (Ollama).
  credentialSchema: null,

  async *run(input: RunInput, ctx: RunContext): AsyncIterable<AgentEvent> {
    const base = (): Pick<AgentEvent, 'attemptId' | 'provider' | 'timestamp'> => ({
      attemptId: ctx.attemptId,
      provider: 'claude',
      timestamp: new Date().toISOString(),
    });

    const abortController = new AbortController();
    ctx.signal?.addEventListener('abort', () => {
      abortController.abort();
    });

    const options: Options = {
      cwd: ctx.workspacePath,
      abortController,
      includePartialMessages: true,
      ...(input.maxTurns !== undefined && { maxTurns: input.maxTurns }),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      env: {
        ANTHROPIC_API_KEY: ctx.runToken,
        ANTHROPIC_BASE_URL: `${ctx.proxyUrl}/providers/claude`,
      },
    };

    try {
      const stream = query({ prompt: input.task, options });
      for await (const message of stream) {
        yield* toAgentEvents(message, base);
      }
    } catch (error) {
      yield {
        ...base(),
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        recoverable: false,
      };
      yield { ...base(), type: 'done', outcome: 'failed', usage: null };
    }
  },
};

function* toAgentEvents(
  message: SDKMessage,
  base: () => Pick<AgentEvent, 'attemptId' | 'provider' | 'timestamp'>,
): Generator<AgentEvent> {
  switch (message.type) {
    case 'stream_event': {
      const event = message.event as {
        type?: string;
        delta?: { type?: string; text?: string; thinking?: string };
      };
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        yield {
          ...base(),
          type: 'message_delta',
          role: 'assistant',
          text: event.delta.text ?? '',
        };
      } else if (
        event.type === 'content_block_delta' &&
        event.delta?.type === 'thinking_delta'
      ) {
        yield { ...base(), type: 'thinking', text: event.delta.thinking ?? '' };
      }
      return;
    }

    case 'assistant': {
      if (message.error) {
        yield { ...base(), type: 'error', message: message.error, recoverable: false };
      }
      const content = message.message.content as ReadonlyArray<{
        type: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>;
      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        const toolCallId = block.id ?? '';
        const name = block.name ?? '';
        yield { ...base(), type: 'tool_call', toolCallId, name, input: block.input };
        if (FILE_EDIT_TOOLS.has(name)) {
          const input = block.input as { file_path?: string; path?: string } | undefined;
          const path = input?.file_path ?? input?.path ?? '';
          yield { ...base(), type: 'file_edit', path, diff: JSON.stringify(block.input) };
        }
      }
      return;
    }

    case 'user': {
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content as ReadonlyArray<{
        type: string;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      }>) {
        if (block.type !== 'tool_result') continue;
        yield {
          ...base(),
          type: 'tool_result',
          toolCallId: block.tool_use_id ?? '',
          output: block.content,
          isError: block.is_error ?? false,
        };
      }
      return;
    }

    case 'result': {
      yield {
        ...base(),
        type: 'done',
        outcome: message.is_error ? 'failed' : 'succeeded',
        usage: {
          inputTokens: message.usage.input_tokens ?? null,
          outputTokens: message.usage.output_tokens ?? null,
          costUsd: message.total_cost_usd,
          latencyMs: message.duration_ms,
        },
      };
      return;
    }

    default:
      // Everything else (system messages, background-task chatter, hook progress, …)
      // is genuinely out of scope for `AgentEvent` — normalizing it would mean
      // inventing a variant nothing in the union needs yet. See adapter-authoring's
      // "never emulate a capability silently": silence here is the honest choice.
      return;
  }
}
