import { describe, expect, it } from 'vitest';
import { resolveSkillDelivery, CLAUDE_SKILLS_DIR } from './delivery.js';
import type { Skill } from './schema.js';

const skill: Skill = {
  name: 'pdf-forms',
  description: 'Fill and flatten PDF forms.',
  license: 'MIT',
  allowedTools: ['Read', 'Write'],
  body: '## Instructions\n\nDo the thing.',
  sourcePath: '/skills/pdf-forms/SKILL.md',
};

describe('resolveSkillDelivery', () => {
  it('mounts into .claude/skills/<name>/SKILL.md for an agentic adapter', () => {
    const delivery = resolveSkillDelivery([skill], true);
    expect(delivery.mode).toBe('mount');
    if (delivery.mode !== 'mount') return;
    expect(delivery.files).toHaveLength(1);
    expect(delivery.files[0]?.relativePath).toBe(
      `${CLAUDE_SKILLS_DIR}/pdf-forms/SKILL.md`,
    );
    expect(delivery.files[0]?.contents).toContain('name: pdf-forms');
    expect(delivery.files[0]?.contents).toContain('Do the thing.');
  });

  it('inlines the skill body into a system prompt for a non-agentic adapter', () => {
    const delivery = resolveSkillDelivery([skill], false);
    expect(delivery.mode).toBe('inline');
    if (delivery.mode !== 'inline') return;
    expect(delivery.systemPrompt).toContain('pdf-forms');
    expect(delivery.systemPrompt).toContain('Do the thing.');
  });

  it('returns an empty inline prompt for no skills on a non-agentic adapter', () => {
    const delivery = resolveSkillDelivery([], false);
    expect(delivery.mode).toBe('inline');
    if (delivery.mode !== 'inline') return;
    expect(delivery.systemPrompt).toBe('');
  });

  it('mounts nothing for no skills on an agentic adapter', () => {
    const delivery = resolveSkillDelivery([], true);
    expect(delivery.mode).toBe('mount');
    if (delivery.mode !== 'mount') return;
    expect(delivery.files).toHaveLength(0);
  });
});
