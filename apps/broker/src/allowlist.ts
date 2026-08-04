/**
 * The one place a container image is decided. The broker's whole reason to exist is
 * that its callers cannot request a container spec — they request *one of these*, by
 * name, and the broker fills in everything else itself. There is no field in the HTTP
 * contract for an arbitrary image, a command, `Privileged`, or a bind mount outside the
 * workspace — see `server.ts`'s request schema.
 *
 * Placeholder images/commands only: there's no adapter registry yet (CLAUDE.md's
 * "Adding a provider adapter" hasn't happened), so this is a naming convention meant to
 * be replaced wholesale once adapters exist, not extended in place.
 */
export interface AllowedImage {
  image: string;
  command: readonly string[];
}

const ALLOWED_IMAGES: ReadonlyMap<string, AllowedImage> = new Map(
  ['claude', 'codex', 'gemini', 'deepseek', 'grok', 'ollama'].map((provider) => [
    `agentmesh/${provider}:latest`,
    { image: `agentmesh/${provider}:latest`, command: ['run'] },
  ]),
);

export function resolveAllowedImage(image: string): AllowedImage | undefined {
  return ALLOWED_IMAGES.get(image);
}
