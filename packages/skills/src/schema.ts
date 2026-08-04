/**
 * The Agent Skills frontmatter shape — the open standard PLAN.md §1 references
 * ("works across Claude Code, Gemini CLI, Codex CLI and ~40 other tools"). A SKILL.md
 * is user-authored content dropped into `AGENTMESH_SKILLS_DIR` by whoever operates this
 * instance, so CLAUDE.md's "trust nothing from a provider response" applies here too —
 * everything below is validated with Zod at the boundary, not assumed well-formed.
 *
 * Field shape follows Anthropic's published Agent Skills spec: `name` and `description`
 * are required, `license` and `allowed-tools` are the only other frontmatter keys the
 * standard defines today. Deliberately not widened with AgentMesh-specific keys — a
 * skill authored for Claude Code or Gemini CLI must parse here unmodified, which is the
 * entire point of building against the open standard instead of a bespoke one.
 */
import { z } from 'zod';

/**
 * Matches the standard's own constraint: lowercase letters, digits, and hyphens, no
 * leading/trailing hyphen. This is also the string Claude mounts the skill under
 * (`.claude/skills/<name>/SKILL.md`), so anything a filesystem would choke on is
 * rejected here rather than surfacing as a mount failure later.
 */
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(SKILL_NAME_RE, 'must be lowercase letters, digits, and hyphens (kebab-case)');

/**
 * The standard keeps this short on purpose — it's what a model reads to decide whether
 * to invoke the skill at all, not documentation. 1024 matches the published spec's own
 * limit.
 */
export const SkillDescriptionSchema = z.string().min(1).max(1024);

export const SkillFrontmatterSchema = z.object({
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  license: z.string().min(1).max(256).optional(),
  /** Tool names this skill expects to be available. Advisory only — nothing here enforces it. */
  'allowed-tools': z.array(z.string().min(1)).optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/** Body length floor — an empty body is a frontmatter-only stub, not a usable skill. */
const MAX_BODY_LENGTH = 1_000_000;

/**
 * A fully parsed, validated skill: frontmatter plus the instruction body Claude (or an
 * inlined system prompt, for non-agentic providers) actually reads. `sourcePath` is
 * the directory or file it was loaded from — kept for error messages and for mounting,
 * never trusted as an identity (`name` is the identity; see loader.ts).
 */
export interface Skill {
  name: string;
  description: string;
  license: string | undefined;
  allowedTools: readonly string[] | undefined;
  /** The markdown body, frontmatter stripped — what gets mounted or inlined verbatim. */
  body: string;
  sourcePath: string;
}

export const SkillBodySchema = z.string().min(1).max(MAX_BODY_LENGTH);
