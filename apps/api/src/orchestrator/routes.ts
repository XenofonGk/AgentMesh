/**
 * The orchestrator's HTTP surface: start a run, check on it. Behind `requireSession`
 * like every other authenticated route.
 *
 * Provider images aren't configurable yet — there's no adapter registry to look them up
 * in, since adapter-authoring (CLAUDE.md) hasn't happened. `imageForProvider` is a
 * placeholder naming convention only, meant to be replaced wholesale once adapters
 * exist, not extended in place.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Database } from '@agentmesh/db';
import { schema } from '@agentmesh/db';
import { loadSkillsFromDir, SkillNameSchema, type Skill } from '@agentmesh/skills';
import { requireSession } from '../auth/guard.js';
import type { Orchestrator, AttemptImage } from './orchestrator.js';

const { runs, attempts } = schema;

const ProviderName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase letters, digits, and hyphens');

const StartRunBody = z.object({
  task: z.string().min(1).max(16384),
  providers: z.array(ProviderName).min(1).max(8),
  /** Names of skills (`Skill.name`) to attach — resolved against `AGENTMESH_SKILLS_DIR`. */
  skills: z.array(SkillNameSchema).max(32).optional(),
});

function imageForProvider(provider: string): AttemptImage {
  return { provider, image: `agentmesh/${provider}:latest`, command: ['run'] };
}

/**
 * Resolves requested skill names against `AGENTMESH_SKILLS_DIR`. A directory that
 * doesn't exist yet resolves to "no skills available" rather than an error — an
 * operator who hasn't set up skills at all shouldn't have every run start failing, and
 * `skillNames.length === 0` (the common case) never touches the filesystem regardless.
 */
async function resolveSkills(
  skillsDir: string,
  skillNames: readonly string[],
): Promise<Skill[] | { error: string }> {
  if (skillNames.length === 0) return [];

  const loaded = await loadSkillsFromDir(skillsDir);
  if (!loaded.ok) {
    return { error: `unable to read skills directory: ${loaded.error.kind}` };
  }

  const byName = new Map(loaded.value.map((skill) => [skill.name, skill]));
  const resolved: Skill[] = [];
  for (const name of skillNames) {
    const skill = byName.get(name);
    if (!skill) return { error: `unknown skill: ${name}` };
    resolved.push(skill);
  }
  return resolved;
}

export async function registerOrchestratorRoutes(
  server: FastifyInstance,
  db: Database,
  orchestrator: Orchestrator,
  proxyUrl: string,
  apiUrl: string,
  skillsDir: string,
): Promise<void> {
  const guard = { preHandler: requireSession(db) };

  server.post('/runs', guard, async (request, reply) => {
    const body = StartRunBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const skills = await resolveSkills(skillsDir, body.data.skills ?? []);
    if (!Array.isArray(skills)) {
      return reply.code(400).send({ error: 'invalid_skills', message: skills.error });
    }

    const result = await orchestrator.startRun({
      userId: request.userId!,
      task: body.data.task,
      proxyUrl,
      apiUrl,
      attempts: body.data.providers.map(imageForProvider),
      skills,
    });

    return reply.code(201).send(result);
  });

  server.get('/runs/:id', guard, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_id' });
    }

    const [run] = await db.select().from(runs).where(eq(runs.id, params.data.id));
    if (!run || run.userId !== request.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const attemptRows = await db
      .select()
      .from(attempts)
      .where(eq(attempts.runId, run.id));

    return reply.send({
      id: run.id,
      task: run.task,
      status: run.status,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      attempts: attemptRows.map((attempt) => ({
        id: attempt.id,
        provider: attempt.provider,
        status: attempt.status,
        costUsd: attempt.costUsd,
        latencyMs: attempt.latencyMs,
        inputTokens: attempt.inputTokens,
        outputTokens: attempt.outputTokens,
        outcome: attempt.outcome,
        errorMessage: attempt.errorMessage,
        createdAt: attempt.createdAt,
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
      })),
    });
  });
}
