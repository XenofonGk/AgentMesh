/**
 * Cross-provider skill delivery — PLAN.md §5 Phase 4: "for Claude, mount into
 * `.claude/skills/`; for providers without native skill support, inline the SKILL.md
 * body into the system prompt. Same artifact, different delivery."
 *
 * Deliberately provider-agnostic: this module decides *what* to hand back for a given
 * `agentic` capability, never *how* a container is spawned — that split matches the
 * orchestrator's own boundary (`apps/api/src/orchestrator/orchestrator.ts`'s doc
 * comment: it "does not talk to a provider adapter, or decide what image/command a
 * provider needs"). The runner (`apps/runner`) is what actually calls this, once it
 * already knows which adapter — and therefore which capability — it's running.
 */
import type { Skill } from './schema.js';

/** Relative to the runner's workspace mount — see `AGENTMESH_WORKSPACE_PATH`. */
export const CLAUDE_SKILLS_DIR = '.claude/skills';

export interface MountedSkillFile {
  /** Relative path, e.g. `.claude/skills/my-skill/SKILL.md` — join with the workspace root. */
  relativePath: string;
  contents: string;
}

export type SkillDelivery =
  | { mode: 'mount'; files: readonly MountedSkillFile[] }
  | { mode: 'inline'; systemPrompt: string };

/** Reconstructs the exact `SKILL.md` bytes (frontmatter + body) for mounting verbatim. */
function toSkillMarkdown(skill: Skill): string {
  const frontmatterLines = [
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    ...(skill.license ? [`license: ${JSON.stringify(skill.license)}`] : []),
    ...(skill.allowedTools
      ? [`allowed-tools: ${JSON.stringify(skill.allowedTools)}`]
      : []),
  ];
  return `---\n${frontmatterLines.join('\n')}\n---\n\n${skill.body}\n`;
}

/**
 * Picks the delivery mechanism for a set of skills given whether the destination
 * adapter is agentic (`AdapterCapabilities.agentic` — Claude today; any future
 * subprocess-CLI-based adapter with native skill support tomorrow). Mounting only
 * makes sense where something reads `.claude/skills/` off disk on its own; every other
 * adapter gets the same content folded into a system prompt string instead.
 */
export function resolveSkillDelivery(
  skills: readonly Skill[],
  agentic: boolean,
): SkillDelivery {
  if (agentic) {
    return {
      mode: 'mount',
      files: skills.map((skill) => ({
        relativePath: `${CLAUDE_SKILLS_DIR}/${skill.name}/SKILL.md`,
        contents: toSkillMarkdown(skill),
      })),
    };
  }

  if (skills.length === 0) {
    return { mode: 'inline', systemPrompt: '' };
  }

  const sections = skills.map(
    (skill) => `## Skill: ${skill.name}\n\n${skill.description}\n\n${skill.body}`,
  );
  return {
    mode: 'inline',
    systemPrompt: [
      'The following skills are available. Apply them when relevant to the task.',
      ...sections,
    ].join('\n\n'),
  };
}
