/**
 * The testable core of `main.ts`, split out so a test can drive it with a fake adapter
 * and a mocked `fetch` instead of a real subprocess/network — `main.ts` itself is just
 * env-loading, adapter lookup, and process wiring around this.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentEvent, ModelAdapter, RunContext } from '@agentmesh/core';
import { resolveSkillDelivery, type Skill } from '@agentmesh/skills';
import type { RunnerConfig } from './config.js';

/**
 * Parses `AGENTMESH_SKILLS`. Not re-validated with `SkillFrontmatterSchema` here — the
 * orchestrator only ever serializes skills that already passed `loadSkillsFromDir`'s
 * validation on the API side, so this is a shape check against programmer error in that
 * serialization, not a trust boundary against operator input the way `loader.ts` is.
 */
function parseSkills(raw: string | undefined): readonly Skill[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Skill[]) : [];
  } catch {
    return [];
  }
}

/**
 * The Claude half of "same artifact, different delivery" (PLAN.md §5 Phase 4): writes
 * each skill's `SKILL.md` into the workspace mount, under `.claude/skills/<name>/`,
 * before the adapter's subprocess starts — Claude discovers skills there on its own,
 * no adapter-side plumbing needed. The non-agentic half (`RunInput.systemPrompt`) needs
 * no filesystem access at all, so it stays inline in `runAttempt` below.
 */
async function mountSkillFiles(
  workspacePath: string,
  files: ReadonlyArray<{ relativePath: string; contents: string }>,
): Promise<void> {
  for (const file of files) {
    const fullPath = join(workspacePath, file.relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, file.contents, 'utf8');
  }
}

export async function reportEvent(
  apiUrl: string,
  runToken: string,
  event: AgentEvent,
): Promise<void> {
  const response = await fetch(`${apiUrl}/internal/attempts/${event.attemptId}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agentmesh-run-token': runToken },
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    console.error(
      `failed to report event (${event.type}): ${response.status.toString()}`,
    );
  }
}

/** Returns whether the attempt should be treated as successful — `main.ts`'s exit code. */
export async function runAttempt(
  config: RunnerConfig,
  adapter: ModelAdapter | undefined,
): Promise<boolean> {
  const base = {
    attemptId: config.AGENTMESH_ATTEMPT_ID,
    provider: config.AGENTMESH_PROVIDER,
  };

  if (!adapter) {
    await reportEvent(config.AGENTMESH_API_URL, config.AGENTMESH_RUN_TOKEN, {
      ...base,
      timestamp: new Date().toISOString(),
      type: 'error',
      message: `no adapter registered for provider "${config.AGENTMESH_PROVIDER}"`,
      recoverable: false,
    });
    await reportEvent(config.AGENTMESH_API_URL, config.AGENTMESH_RUN_TOKEN, {
      ...base,
      timestamp: new Date().toISOString(),
      type: 'done',
      outcome: 'failed',
      usage: null,
    });
    return false;
  }

  const ctx: RunContext = {
    attemptId: config.AGENTMESH_ATTEMPT_ID,
    proxyUrl: config.AGENTMESH_PROXY_URL,
    runToken: config.AGENTMESH_RUN_TOKEN,
    workspacePath: config.AGENTMESH_WORKSPACE_PATH,
  };

  const skills = parseSkills(config.AGENTMESH_SKILLS);
  const delivery = resolveSkillDelivery(skills, adapter.capabilities.agentic);
  if (delivery.mode === 'mount') {
    await mountSkillFiles(config.AGENTMESH_WORKSPACE_PATH, delivery.files);
  }
  const runInput = {
    task: config.AGENTMESH_TASK,
    ...(delivery.mode === 'inline' && delivery.systemPrompt && {
      systemPrompt: delivery.systemPrompt,
    }),
  };

  let sawDone = false;
  let succeeded = false;
  for await (const event of adapter.run(runInput, ctx)) {
    if (event.type === 'done') {
      sawDone = true;
      succeeded = event.outcome === 'succeeded';
    }
    await reportEvent(config.AGENTMESH_API_URL, config.AGENTMESH_RUN_TOKEN, event);
  }

  if (!sawDone) {
    await reportEvent(config.AGENTMESH_API_URL, config.AGENTMESH_RUN_TOKEN, {
      ...base,
      timestamp: new Date().toISOString(),
      type: 'done',
      outcome: 'failed',
      usage: null,
    });
    return false;
  }

  return succeeded;
}
