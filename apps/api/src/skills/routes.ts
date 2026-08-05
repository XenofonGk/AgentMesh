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
import {
  activateSkillVersion,
  createSkillVersion,
  getActiveSkillVersion,
  getSkillVersion,
  listSkillVersions,
  recordSkillVersionEvalResult,
  rejectSkillVersion,
} from '@agentmesh/db';
import {
  SkillNameSchema,
  parseSkillMarkdown,
  compareSkillVersions,
  type RunExecutor,
} from '@agentmesh/skills';
import { requireSession } from '../auth/guard.js';

const NameParam = z.object({ name: SkillNameSchema });
const VersionParam = z.object({
  name: SkillNameSchema,
  version: z.coerce.number().int().positive(),
});

const PutSkillBody = z.object({
  content: z.string().min(1).max(1_000_000),
});

const ProposeVersionBody = z.object({
  content: z.string().min(1).max(1_000_000),
});

const EvaluateVersionBody = z.object({
  testSet: z
    .array(
      z.object({
        task: z.string().min(1),
        providers: z.array(z.string().min(1)).optional(),
      }),
    )
    .min(1),
  providers: z.array(z.string().min(1)).min(1),
  sampleCount: z.number().int().min(1).max(20).default(1),
});

/** Where a given skill's `SKILL.md` lives, given an already-`SkillNameSchema`-validated name. */
function skillMdPath(skillsDir: string, name: string): string {
  return join(resolve(skillsDir), name, 'SKILL.md');
}

export async function registerSkillRoutes(
  server: FastifyInstance,
  db: Database,
  skillsDir: string,
  /**
   * Injected the same way `RunExecutor` is everywhere else in `@agentmesh/skills` — this
   * module never starts a sandbox itself. Omit it (the default; nothing wires one in
   * today) and the evaluate route responds 501 rather than silently no-op-ing.
   */
  executor?: RunExecutor,
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
          ? {
              name: result.value.name,
              description: result.value.description,
              valid: true as const,
            }
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

    // Normal in-app editor save: a human editing directly is already the GATE, so this
    // auto-activates — writes both the version-history row and the live file. Contrast
    // with `POST /skills/:name/versions` below (the PROPOSE step), which never does.
    await createSkillVersion(db, {
      skillName: params.data.name,
      content: body.data.content,
      createdBy: request.userId ?? null,
      activate: true,
    });

    await mkdir(resolve(skillsDir, params.data.name), { recursive: true });
    await writeFile(path, body.data.content, 'utf8');

    return reply.code(200).send({ name: params.data.name });
  });

  // ---- VERSION / PROPOSE / EVALUATE / GATE -------------------------------------------

  /** History for a skill's versions, newest first — feeds the web UI's version list. */
  server.get('/skills/:name/versions', guard, async (request, reply) => {
    const params = NameParam.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_name' });
    }
    const versions = await listSkillVersions(db, params.data.name);
    return reply.send({ versions });
  });

  /**
   * PROPOSE: records a new version as `'proposed'` without ever touching the live
   * `SKILL.md`. This is the entry point the improvement loop's PROPOSE step (or any
   * human drafting a change outside the normal editor save) uses — it always needs an
   * explicit GATE call (`.../activate`) before it goes live.
   */
  server.post('/skills/:name/versions', guard, async (request, reply) => {
    const params = NameParam.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_name' });
    }

    const body = ProposeVersionBody.safeParse(request.body);
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
        message: 'frontmatter `name` must match the skill being proposed for',
      });
    }

    const row = await createSkillVersion(db, {
      skillName: params.data.name,
      content: body.data.content,
      createdBy: request.userId ?? null,
      activate: false,
    });

    return reply.code(201).send({ version: row });
  });

  /**
   * EVALUATE integration: runs `compareSkillVersions` (`@agentmesh/skills`) between the
   * currently active version and a proposed one, and stores the report on the proposed
   * version's row — evidence for a human to look at before GATE-ing it, never something
   * this route acts on itself. Requires a `RunExecutor`-shaped callback; since this
   * module never starts a sandbox itself (CLAUDE.md), the caller must inject one — there
   * is no default HTTP executor wired in here to avoid the API calling back into itself.
   */
  server.post(
    '/skills/:name/versions/:version/evaluate',
    guard,
    async (request, reply) => {
      const params = VersionParam.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid_params' });
      }
      const body = EvaluateVersionBody.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      if (executor === undefined) {
        return reply.code(501).send({ error: 'evaluation_not_configured' });
      }

      const candidateRow = await getSkillVersion(
        db,
        params.data.name,
        params.data.version,
      );
      if (!candidateRow) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const candidateParsed = parseSkillMarkdown(candidateRow.content, 'candidate');
      if (!candidateParsed.ok) {
        return reply
          .code(400)
          .send({ error: 'invalid_skill', details: candidateParsed.error });
      }

      const activeRow = await getActiveSkillVersion(db, params.data.name);
      let baselineSkill;
      if (activeRow) {
        const activeParsed = parseSkillMarkdown(activeRow.content, 'active');
        if (!activeParsed.ok) {
          return reply
            .code(400)
            .send({ error: 'invalid_active_skill', details: activeParsed.error });
        }
        baselineSkill = activeParsed.value;
      } else {
        // No active version yet on disk — read the live `SKILL.md` directly (may be the
        // pre-versioning skill this repo already had).
        let raw: string;
        try {
          raw = await readFile(skillMdPath(skillsDir, params.data.name), 'utf8');
        } catch {
          return reply.code(404).send({ error: 'no_baseline' });
        }
        const parsed = parseSkillMarkdown(raw, 'active');
        if (!parsed.ok) {
          return reply
            .code(400)
            .send({ error: 'invalid_active_skill', details: parsed.error });
        }
        baselineSkill = parsed.value;
      }

      const report = await compareSkillVersions({
        baseline: [baselineSkill],
        candidate: [candidateParsed.value],
        testSet: body.data.testSet,
        providers: body.data.providers,
        sampleCount: body.data.sampleCount,
        executor,
      });

      await recordSkillVersionEvalResult(
        db,
        params.data.name,
        params.data.version,
        report,
      );

      return reply.send({ report });
    },
  );

  /** GATE: promotes a `'proposed'` version to `'active'` and writes it to the live file. */
  server.post(
    '/skills/:name/versions/:version/activate',
    guard,
    async (request, reply) => {
      const params = VersionParam.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid_params' });
      }

      const activated = await activateSkillVersion(
        db,
        params.data.name,
        params.data.version,
      );
      if (!activated) {
        return reply.code(404).send({ error: 'not_found_or_not_proposed' });
      }

      await mkdir(resolve(skillsDir, params.data.name), { recursive: true });
      await writeFile(
        skillMdPath(skillsDir, params.data.name),
        activated.content,
        'utf8',
      );

      return reply.send({ version: activated });
    },
  );

  /** GATE: rejects a `'proposed'` version. Never touches the live file. */
  server.post('/skills/:name/versions/:version/reject', guard, async (request, reply) => {
    const params = VersionParam.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' });
    }

    const rejected = await rejectSkillVersion(db, params.data.name, params.data.version);
    if (!rejected) {
      return reply.code(404).send({ error: 'not_found_or_not_proposed' });
    }

    return reply.send({ version: rejected });
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
