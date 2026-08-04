/**
 * Skill CRUD routes against a real Postgres (for session auth) and a real temp
 * directory (for `AGENTMESH_SKILLS_DIR`) — same "refuse to skip if configured but
 * unreachable" convention as `events/routes.test.ts` and `credentials/routes.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createSession,
  createUserWithPassword,
  runMigrations,
  type DatabaseHandle,
} from '@agentmesh/db';
import { buildServer, type App } from '../server.js';
import { loadConfig } from '../config.js';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie.js';

const CONNECTION = process.env['TEST_DATABASE_URL'] ?? '';

async function reachable(): Promise<boolean> {
  if (CONNECTION === '') return false;
  const probe = createDatabase(CONNECTION);
  try {
    return await probe.ping();
  } finally {
    await probe.close();
  }
}

const available = await reachable();
if (CONNECTION !== '' && !available) {
  throw new Error(
    'routes.test.ts: TEST_DATABASE_URL is set but unreachable. Refusing to skip.',
  );
}

const describeDb = available ? describe : describe.skip;

const VALID_SKILL = `---
name: test-skill
description: A skill used in tests.
---

Do the thing.
`;

describeDb('skill routes', () => {
  let handle: DatabaseHandle;
  let app: App | undefined;
  let skillsDir: string;

  beforeAll(async () => {
    await runMigrations(CONNECTION);
    handle = createDatabase(CONNECTION);
  });

  beforeEach(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), 'agentmesh-skills-'));
  });

  afterEach(async () => {
    await app?.server.close();
    app = undefined;
    await rm(skillsDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function freshApp(): Promise<{ app: App; cookie: string }> {
    const config = loadConfig({
      DATABASE_URL: CONNECTION,
      WEB_ORIGIN: 'http://localhost:3000',
      LOG_LEVEL: 'silent',
      AGENTMESH_SKILLS_DIR: skillsDir,
    });
    const built = await buildServer({ config, database: handle });
    app = built;

    const email = `${randomUUID()}@example.test`;
    const { userId } = await createUserWithPassword(
      handle.db,
      email,
      'a genuinely long passphrase',
    );
    const token = await createSession(handle.db, userId);
    return { app: built, cookie: `${SESSION_COOKIE_NAME}=${token}` };
  }

  it('requires auth on every mutating route', async () => {
    const { app: built } = await freshApp();

    const list = await built.server.inject({ method: 'GET', url: '/skills' });
    expect(list.statusCode).toBe(401);

    const get = await built.server.inject({ method: 'GET', url: '/skills/test-skill' });
    expect(get.statusCode).toBe(401);

    const put = await built.server.inject({
      method: 'PUT',
      url: '/skills/test-skill',
      payload: { content: VALID_SKILL },
    });
    expect(put.statusCode).toBe(401);

    const del = await built.server.inject({ method: 'DELETE', url: '/skills/test-skill' });
    expect(del.statusCode).toBe(401);
  });

  it('lists no skills against an empty directory', async () => {
    const { app: built, cookie } = await freshApp();
    const response = await built.server.inject({
      method: 'GET',
      url: '/skills',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ skills: [] });
  });

  it('creates a valid skill, then lists, gets, and deletes it', async () => {
    const { app: built, cookie } = await freshApp();

    const put = await built.server.inject({
      method: 'PUT',
      url: '/skills/test-skill',
      headers: { cookie },
      payload: { content: VALID_SKILL },
    });
    expect(put.statusCode).toBe(200);

    const list = await built.server.inject({
      method: 'GET',
      url: '/skills',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      skills: [{ name: 'test-skill', description: 'A skill used in tests.', valid: true }],
    });

    const get = await built.server.inject({
      method: 'GET',
      url: '/skills/test-skill',
      headers: { cookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ name: 'test-skill', content: VALID_SKILL });

    const del = await built.server.inject({
      method: 'DELETE',
      url: '/skills/test-skill',
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);

    const getAfterDelete = await built.server.inject({
      method: 'GET',
      url: '/skills/test-skill',
      headers: { cookie },
    });
    expect(getAfterDelete.statusCode).toBe(404);
  });

  it('rejects invalid content with 400 and never writes to disk', async () => {
    const { app: built, cookie } = await freshApp();

    const put = await built.server.inject({
      method: 'PUT',
      url: '/skills/test-skill',
      headers: { cookie },
      payload: { content: 'not a valid skill file, no frontmatter' },
    });
    expect(put.statusCode).toBe(400);

    const list = await built.server.inject({
      method: 'GET',
      url: '/skills',
      headers: { cookie },
    });
    expect(list.json()).toEqual({ skills: [] });
  });

  it('rejects a path-traversal-shaped name outright', async () => {
    const { app: built, cookie } = await freshApp();

    const put = await built.server.inject({
      method: 'PUT',
      url: `/skills/${encodeURIComponent('../../etc/passwd')}`,
      headers: { cookie },
      payload: { content: VALID_SKILL },
    });
    expect(put.statusCode).toBe(400);

    const get = await built.server.inject({
      method: 'GET',
      url: `/skills/${encodeURIComponent('..')}`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(400);

    const del = await built.server.inject({
      method: 'DELETE',
      url: `/skills/${encodeURIComponent('..')}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(400);
  });
});
