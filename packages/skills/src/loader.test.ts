import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillMarkdown, loadSkill, loadSkillsFromDir } from './loader.js';

const VALID_SKILL_MD = `---
name: pdf-forms
description: Fill and flatten PDF forms given a template and field values.
license: MIT
allowed-tools:
  - Read
  - Write
---

## Instructions

1. Read the template.
2. Fill the fields.
`;

describe('parseSkillMarkdown', () => {
  it('parses a valid SKILL.md into a typed Skill', () => {
    const result = parseSkillMarkdown(VALID_SKILL_MD, '/skills/pdf-forms/SKILL.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('pdf-forms');
    expect(result.value.description).toContain('Fill and flatten');
    expect(result.value.license).toBe('MIT');
    expect(result.value.allowedTools).toEqual(['Read', 'Write']);
    expect(result.value.body).toContain('## Instructions');
    expect(result.value.body.startsWith('---')).toBe(false);
  });

  it('rejects a file with no frontmatter block', () => {
    const result = parseSkillMarkdown('just a markdown body, no frontmatter', '/x/SKILL.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no_frontmatter');
  });

  it('rejects frontmatter missing the required name field', () => {
    const raw = `---\ndescription: missing a name\n---\n\nbody\n`;
    const result = parseSkillMarkdown(raw, '/x/SKILL.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_frontmatter');
    expect(result.error.message).toContain('name');
  });

  it('rejects frontmatter missing the required description field', () => {
    const raw = `---\nname: my-skill\n---\n\nbody\n`;
    const result = parseSkillMarkdown(raw, '/x/SKILL.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_frontmatter');
    expect(result.error.message).toContain('description');
  });

  it('rejects a name that is not kebab-case', () => {
    const raw = `---\nname: My_Skill!\ndescription: bad name\n---\n\nbody\n`;
    const result = parseSkillMarkdown(raw, '/x/SKILL.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_frontmatter');
  });

  it('rejects malformed YAML frontmatter', () => {
    const raw = `---\nname: [unterminated\n---\n\nbody\n`;
    const result = parseSkillMarkdown(raw, '/x/SKILL.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_frontmatter');
  });

  it('rejects an empty body', () => {
    const raw = `---\nname: my-skill\ndescription: has no body\n---\n`;
    const result = parseSkillMarkdown(raw, '/x/SKILL.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_body');
  });
});

describe('loadSkill / loadSkillsFromDir', () => {
  it('loads a real SKILL.md from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentmesh-skills-'));
    try {
      const skillDir = join(dir, 'pdf-forms');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), VALID_SKILL_MD, 'utf8');

      const result = await loadSkill(join(skillDir, 'SKILL.md'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe('pdf-forms');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a read_error for a missing file', async () => {
    const result = await loadSkill('/nonexistent/SKILL.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('read_error');
  });

  it('loads every valid skill in a directory and skips subdirectories without a SKILL.md', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentmesh-skills-'));
    try {
      await mkdir(join(dir, 'pdf-forms'), { recursive: true });
      await writeFile(join(dir, 'pdf-forms', 'SKILL.md'), VALID_SKILL_MD, 'utf8');
      await mkdir(join(dir, 'scratch'), { recursive: true }); // no SKILL.md — skipped

      const result = await loadSkillsFromDir(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.name).toBe('pdf-forms');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces a validation error for an invalid skill in the directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentmesh-skills-'));
    try {
      await mkdir(join(dir, 'broken'), { recursive: true });
      await writeFile(join(dir, 'broken', 'SKILL.md'), 'no frontmatter here', 'utf8');

      const result = await loadSkillsFromDir(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('no_frontmatter');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
