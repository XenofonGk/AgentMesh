/**
 * The testable core of `main.ts`, split out so a test can drive it with a fake adapter
 * and a mocked `fetch` instead of a real subprocess/network — `main.ts` itself is just
 * env-loading, adapter lookup, and process wiring around this.
 */
import type { AgentEvent, ModelAdapter, RunContext } from '@agentmesh/core';
import type { RunnerConfig } from './config.js';

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

  let sawDone = false;
  let succeeded = false;
  for await (const event of adapter.run({ task: config.AGENTMESH_TASK }, ctx)) {
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
