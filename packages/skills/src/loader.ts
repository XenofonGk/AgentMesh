/**
 * Parses and validates a `SKILL.md` file — CLAUDE.md's "typed `Result`-style returns
 * for expected failures; throw only for programmer error." A malformed skill authored
 * by an operator is an expected failure (bad user input), not a programmer error, so
 * this never throws for it — `loadSkill`/`loadSkillsFromDir` return a `Result`.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
 * Parses already-read SKILL.md text. Split from `loadSkill` so tests (and, later, an
 * in-app editor's live-validation preview — not built here, PLAN.md Phase 4) can
 * validate a string without touching the filesystem.
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

/** Loads and validates a single `SKILL.md` file from an absolute or relative path. */
export async function loadSkill(
  skillMdPath: string,
): Promise<Result<Skill, SkillValidationError>> {
  const sourcePath = resolve(skillMdPath);
  let raw: string;
  try {
    raw = await readFile(sourcePath, 'utf8');
  } catch (error) {
    return err({
      kind: 'read_error',
      sourcePath,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return parseSkillMarkdown(raw, sourcePath);
}

/**
 * Loads every skill in `rootDir` — one subdirectory per skill, each containing its own
 * `SKILL.md`, matching the standard's on-disk layout (and what Claude expects under
 * `.claude/skills/`). A subdirectory without a `SKILL.md` is silently skipped rather
 * than treated as an error: `AGENTMESH_SKILLS_DIR` may reasonably contain scratch
 * directories, READMEs, or a skill under construction.
 */
export async function loadSkillsFromDir(
  rootDir: string,
): Promise<Result<readonly Skill[], SkillValidationError>> {
  const root = resolve(rootDir);
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    return err({
      kind: 'read_error',
      sourcePath: root,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const skills: Skill[] = [];
  for (const name of entries) {
    const skillMdPath = join(root, name, 'SKILL.md');
    const result = await loadSkill(skillMdPath).catch(
      (): Result<Skill, SkillValidationError> => ({
        ok: false,
        error: { kind: 'read_error', sourcePath: skillMdPath, message: 'unreadable' },
      }),
    );
    if (!result.ok) {
      if (result.error.kind === 'read_error') continue; // no SKILL.md here — skip, see doc comment
      return result;
    }
    skills.push(result.value);
  }

  return ok(skills);
}
