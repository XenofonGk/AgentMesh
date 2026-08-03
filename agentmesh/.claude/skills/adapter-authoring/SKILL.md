---
name: adapter-authoring
description: The procedure for adding or modifying a model provider adapter in AgentMesh (Claude, Gemini, DeepSeek, Grok, Ollama, or a new one). Use this skill whenever the task involves adding a provider, changing how provider output is normalized, touching the ModelAdapter interface or the AgentEvent union, or debugging inconsistent behavior between providers. Also trigger when the user mentions adding a model, supporting a new API, or streaming differences between providers.
---

# Authoring a Model Adapter

The adapter layer is the core abstraction of AgentMesh. Its value comes entirely from
consistency — if two adapters normalize events differently, the comparison feature is
meaningless and the UI accumulates provider-specific special cases.

## The contract

```ts
interface ModelAdapter {
  id: string;
  capabilities: {
    agentic: boolean;
    streaming: boolean;
    toolUse: boolean;
    maxContextTokens: number;
  };
  credentialSchema: ZodSchema | null;   // null when no key is needed (Ollama)
  run(input: RunInput, ctx: RunContext): AsyncIterable<AgentEvent>;
  estimateCost?(usage: Usage): number | null;
}
```

## Rules

1. **Never leak a raw provider payload.** Everything is coerced to `AgentEvent` before it
   leaves `run()`. The DB and UI must never learn which provider produced an event except via
   the `provider` field.
2. **Never read a credential.** The adapter sends requests to the proxy base URL from
   `ctx.proxyUrl`. If you find yourself reaching for `process.env.SOMETHING_API_KEY`, stop —
   that is an architecture violation, not a shortcut.
3. **Degrade honestly.** If a provider lacks a capability, declare it `false` in `capabilities`.
   Never emulate a capability silently — the UI needs to know so it can tell the user.
4. **Stream incrementally.** Never buffer a full response and emit once. Partial output is the
   product.
5. **Errors are events.** Emit `{ type: 'error' }` rather than throwing, so a failing provider in
   a parallel bake-off doesn't take down the other three.

## Procedure

1. Read an existing adapter first — `packages/adapters/claude` (agentic) or
   `packages/adapters/ollama` (simple, credential-free). Match its shape.
2. Map the provider's stream format to `AgentEvent` on paper before coding. Note every case
   where the mapping is lossy or ambiguous and write it down in the adapter's header comment.
3. Implement `run()`. Keep provider-specific parsing in one clearly-marked block.
4. Write tests:
   - normalization: a recorded provider stream → expected `AgentEvent[]`
   - error handling: malformed chunk, mid-stream disconnect, auth failure
   - **no-credential test**: assert the adapter never reads a key from its environment
5. Register in the adapter registry; add capabilities to the docs table.
6. Run the `security-review` skill if the adapter touches the proxy path.

## Common traps

- Providers differ on whether tool calls arrive as deltas or complete blocks. Normalize to
  complete blocks; buffer internally if needed.
- Token accounting is inconsistent and sometimes absent. `estimateCost` returning `null` is
  acceptable and better than a fabricated number.
- Ollama's local models vary enormously in tool-use reliability. Declare `toolUse` per-model,
  not per-provider.
- Reasoning/thinking content is exposed differently everywhere and sometimes not at all. Map to
  `thinking` events only when the provider genuinely labels it as such — never infer.
