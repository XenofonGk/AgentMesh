/**
 * In-app skill editor HTTP surface (PLAN.md Phase 4: "In-app skill editor with live
 * validation"). CRUD over the operator's `AGENTMESH_SKILLS_DIR` — ordinary filesystem
 * work, not the vault/proxy/container-isolation surface CLAUDE.md gates behind asking
 * first.
 *
 * `name` arrives from user input and becomes a path segment
 * (`AGENTMESH_SKILLS_DIR/<name>/SKILL.md`), so every route validates it against
 * `SkillNameSchema` (kebab-case only) *before* touching the filesystem, rather than
 * attempting to sanitize an arbitrary string — same reasoning as
 * `orchestrator/routes.ts`'s `ProviderName`. A name that fails the schema (e.g. `..` or
 * anything with a `/`) is rejected outright, never passed to `join`.
 *
 * Live validation per PLAN.md is split in two: the web app calls
 * `parseSkillMarkdown` (pure, `@agentmesh/skills`) client-side on every debounced
 * keystroke for instant feedback, and this route re-validates server-side on every
 * write, same content, same function — the API boundary is the actual gate (CLAUDE.md:
 * "validate all external input with Zod at the boundary. Trust nothing from a provider
 * response" — and nothing client-side counts as trusted).
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@agentmesh/db';
import { SkillNameSchema, parseSkillMarkdown } from '@agentmesh/skills';
import { requireSession } from '../auth/guard.js';

const NameParam = z.object({ name: SkillNameSchema });

const PutSkillBody = z.object({
  content: z.string().min(1).max(1_000_000),
});

/** Where a given skill's `SKILL.md` lives, given an already-`SkillNameSchema`-validated name. */
function skillMdPath(skillsDir: string, name: string): string {
  return join(resolve(skillsDir), name, 'SKILL.md');
}

export async function registerSkillRoutes(
  server: FastifyInstance,
  db: Database,
  skillsDir: string,
): Promise<void> {
  const guard = { preHandler: requireSession(db) };

  server.get('/skills', guard, async (_request, reply) => {
    const root = resolve(skillsDir);
    let entries: string[];
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      // No skills directory yet — an operator who hasn't set one up sees an empty
      // list, not an error, matching `orchestrator/routes.ts`'s `resolveSkills`.
      return reply.send({ skills: [] });
    }

    const skills = [];
    for (const name of entries) {
      const parsedName = SkillNameSchema.safeParse(name);
      if (!parsedName.success) continue; // not a valid skill directory name — skip

      let raw: string;
      try {
        raw = await readFile(skillMdPath(root, name), 'utf8');
      } catch {
        continue; // no SKILL.md here — same "skip, not an error" as loadSkillsFromDir
      }

      const result = parseSkillMarkdown(raw, skillMdPath(root, name));
      skills.push(
        result.ok
          ? { name: result.value.name, description: result.value.description, valid: true as const }
          : { name, description: null, valid: false as const, error: result.error.kind },
      );
    }

    return reply.send({ skills });
  });

  server.get('/skills/:name', guard, async (request, reply) => {
    const params = NameParam.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_name' });
    }

    const path = skillMdPath(skillsDir, params.data.name);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }

    return reply.send({ name: params.data.name, content: raw });
  });

  server.put('/skills/:name', guard, async (request, reply) => {
    const params = NameParam.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_name' });
    }

    const body = PutSkillBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const path = skillMdPath(skillsDir, params.data.name);
    const result = parseSkillMarkdown(body.data.content, path);
    if (!result.ok) {
      return reply.code(400).send({ error: 'invalid_skill', details: result.error });
    }
    if (result.value.name !== params.data.name) {
      return reply.code(400).send({
        error: 'name_mismatch',
        message: 'frontmatter `name` must match the skill being saved',
      });
    }

    await mkdir(resolve(skillsDir, params.data.name), { recursive: true });
    await writeFile(path, body.data.content, 'utf8');

    return reply.code(200).send({ name: params.data.name });
  });

  server.delete('/skills/:name', guard, async (request, reply) => {
    const params = NameParam.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_name' });
    }

    const dir = resolve(skillsDir, params.data.name);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      return reply.code(500).send({ error: 'delete_failed' });
    }

    return reply.code(204).send();
  });
}
