/**
 * Skill loader, validator, and cross-provider delivery for the Agent Skills standard.
 *
 * Phase 4 (PLAN.md §5). Eval harness and improvement loop are Phase 5 — not here yet.
 */
export { SkillFrontmatterSchema, SkillNameSchema, SkillDescriptionSchema } from './schema.js';
export type { Skill, SkillFrontmatter } from './schema.js';
export { parseSkillMarkdown, loadSkill, loadSkillsFromDir } from './loader.js';
export type { SkillValidationError } from './loader.js';
export { resolveSkillDelivery, CLAUDE_SKILLS_DIR } from './delivery.js';
export type { SkillDelivery, MountedSkillFile } from './delivery.js';
