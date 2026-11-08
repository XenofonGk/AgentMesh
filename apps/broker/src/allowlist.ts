/**
 * The one place a container image is decided. The broker's whole reason to exist is
 * that its callers cannot request a container spec — they request *one of these*, by
 * name, and the broker fills in everything else itself. There is no field in the HTTP
 * contract for an arbitrary image, a command, `Privileged`, or a bind mount outside the
 * workspace — see `server.ts`'s request schema.
 *
 * One shared runner image, multi-tagged per provider name — `infra/runner.Dockerfile`
 * builds one image and the deploy step tags it under every name below;
 * `apps/runner/src/registry.ts` picks the actual adapter at runtime from
 * `AGENTMESH_PROVIDER`. `codex` is reserved for OpenAI's agentic Codex CLI adapter (like
 * `claudeAdapter` wraps the Claude Agent SDK subprocess) — not built yet, name held so
 * the broker-side allowlist doesn't need touching again when it lands. `chatgpt` is
 * OpenAI's plain, non-agentic Chat Completions adapter, which does exist already.
 */
export interface AllowedImage {
  image: string;
  command: readonly string[];
}

const ALLOWED_IMAGES: ReadonlyMap<string, AllowedImage> = new Map(
  ['claude', 'codex', 'gemini', 'deepseek', 'grok', 'chatgpt', 'ollama'].map((provider) => [
    `agentmesh/${provider}:latest`,
    { image: `agentmesh/${provider}:latest`, command: ['run'] },
  ]),
);

export function resolveAllowedImage(image: string): AllowedImage | undefined {
  return ALLOWED_IMAGES.get(image);
}
