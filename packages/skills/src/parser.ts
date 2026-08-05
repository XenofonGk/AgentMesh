/**
 * Parses and validates raw `SKILL.md` text — pure, no filesystem access. Split out from
 * `loader.ts` so browser code (the in-app editor's live-validation preview) can import
 * this without pulling `node:fs`/`node:path` into a webpack bundle — those only exist in
 * `loader.ts`, which wraps this for the server-side, disk-reading path.
 */
import { parse as parseYaml } from 'yaml';
import type { Result } from '@agentmesh/core';
import { ok, err } from '@agentmesh/core';
import { SkillFrontmatterSchema, SkillBodySchema, type Skill } from './schema.js';

export type SkillValidationError =
  | { kind: 'no_frontmatter'; sourcePath: string }
  | { kind: 'invalid_frontmatter'; sourcePath: string; message: string }
  | { kind: 'invalid_body'; sourcePath: string; message: string }
  | { kind: 'read_error'; sourcePath: string; message: string };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parses already-read SKILL.md text. Split from `loadSkill` so tests (and the in-app
 * editor's live-validation preview, PLAN.md Phase 4) can validate a string without
 * touching the filesystem.
 */
export function parseSkillMarkdown(
  raw: string,
  sourcePath: string,
): Result<Skill, SkillValidationError> {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return err({ kind: 'no_frontmatter', sourcePath });
  }
  const [, frontmatterRaw, body] = match;

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(frontmatterRaw ?? '');
  } catch (error) {
    return err({
      kind: 'invalid_frontmatter',
      sourcePath,
      message: `not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const frontmatter = SkillFrontmatterSchema.safeParse(parsedYaml);
  if (!frontmatter.success) {
    return err({
      kind: 'invalid_frontmatter',
      sourcePath,
      message: frontmatter.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    });
  }

  const trimmedBody = (body ?? '').trim();
  const bodyResult = SkillBodySchema.safeParse(trimmedBody);
  if (!bodyResult.success) {
    return err({
      kind: 'invalid_body',
      sourcePath,
      message: bodyResult.error.issues.map((issue) => issue.message).join('; '),
    });
  }

  return ok({
    name: frontmatter.data.name,
    description: frontmatter.data.description,
    license: frontmatter.data.license,
    allowedTools: frontmatter.data['allowed-tools'],
    body: bodyResult.data,
    sourcePath,
  });
}
