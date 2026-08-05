/**
 * Filesystem-backed skill loading — server-side only (imports `node:fs`/`node:path`).
 * The pure parsing logic lives in `parser.ts`; keep it that way so browser code can
 * import `parseSkillMarkdown` without pulling Node built-ins into a webpack bundle.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Result } from '@agentmesh/core';
import { ok, err } from '@agentmesh/core';
import type { Skill } from './schema.js';
import { parseSkillMarkdown, type SkillValidationError } from './parser.js';

export type { SkillValidationError } from './parser.js';
export { parseSkillMarkdown } from './parser.js';

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
