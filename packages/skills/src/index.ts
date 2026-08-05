/**
 * Skill loader, validator, cross-provider delivery, and EVALUATE-step harness for the
 * Agent Skills standard.
 *
 * Phase 4 (PLAN.md §5) built the loader/delivery. Phase 5's EVALUATE step (PLAN.md §6)
 * is `eval.ts` — the rest of the improvement loop (OBSERVE, PROPOSE, GATE, VERSION) is
 * not here yet.
 */
export {
  SkillFrontmatterSchema,
  SkillNameSchema,
  SkillDescriptionSchema,
} from './schema.js';
export type { Skill, SkillFrontmatter } from './schema.js';
export { parseSkillMarkdown } from './parser.js';
export type { SkillValidationError } from './parser.js';
export { loadSkill, loadSkillsFromDir } from './loader.js';
export { resolveSkillDelivery, CLAUDE_SKILLS_DIR } from './delivery.js';
export type { SkillDelivery, MountedSkillFile } from './delivery.js';
export {
  EvalCaseSchema,
  loadTestSet,
  aggregateResults,
  evaluateSkill,
  compareSkillVersions,
} from './eval.js';
export type {
  EvalCase,
  EvalOutcome,
  EvalSampleResult,
  RunExecutor,
  ProviderAggregate,
  EvalReport,
  EvaluateSkillOptions,
  CompareSkillVersionsOptions,
  CompareSkillVersionsReport,
} from './eval.js';
