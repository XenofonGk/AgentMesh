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

/** A minimal valid SKILL.md whose frontmatter `name` matches the given skill name. */
function skillFor(name: string): string {
  return `---\nname: ${name}\ndescription: A skill used in tests.\n---\n\nDo the thing.\n`;
}

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

    const del = await built.server.inject({
      method: 'DELETE',
      url: '/skills/test-skill',
    });
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
      skills: [
        { name: 'test-skill', description: 'A skill used in tests.', valid: true },
      ],
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

    // A bare '..' segment is collapsed by HTTP dot-segment normalization before it
    // ever reaches routing (RFC 3986 §5.2.4) — `/skills/..` resolves to `/`, which 404s
    // without our handler (or its SkillNameSchema check) ever running. That's a safe
    // outcome, just not the 400 our own validation produces, so it's excluded here.
    // '../../etc/passwd' has real segments either side of the dots and survives as one
    // opaque :name param once percent-encoded (encodeURIComponent escapes the slashes),
    // so it does reach the handler and is what actually exercises SkillNameSchema.
    const traversal = encodeURIComponent('../../etc/passwd');

    const get = await built.server.inject({
      method: 'GET',
      url: `/skills/${traversal}`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(400);

    const del = await built.server.inject({
      method: 'DELETE',
      url: `/skills/${traversal}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(400);
  });

  describe('versions (VERSION/PROPOSE/GATE)', () => {
    // Unique per test run (not per-`it`, so the same name is reused within one test's
    // several route calls) — avoids version-number collisions against leftover rows
    // from a prior run against the same TEST_DATABASE_URL.
    const uniq = randomUUID().slice(0, 8);

    it('auto-activates and writes the live file on a normal PUT save', async () => {
      const { app: built, cookie } = await freshApp();

      const put = await built.server.inject({
        method: 'PUT',
        url: `/skills/vskill-a-${uniq}`,
        headers: { cookie },
        payload: { content: skillFor(`vskill-a-${uniq}`) },
      });
      expect(put.statusCode).toBe(200);

      const list = await built.server.inject({
        method: 'GET',
        url: `/skills/vskill-a-${uniq}/versions`,
        headers: { cookie },
      });
      expect(list.statusCode).toBe(200);
      const { versions } = list.json() as {
        versions: { version: number; status: string }[];
      };
      expect(versions).toEqual([{ ...versions[0], version: 1, status: 'active' }]);

      const get = await built.server.inject({
        method: 'GET',
        url: `/skills/vskill-a-${uniq}`,
        headers: { cookie },
      });
      expect(get.json()).toEqual({
        name: `vskill-a-${uniq}`,
        content: skillFor(`vskill-a-${uniq}`),
      });
    });

    it('proposing a version records it as proposed and never touches the live file', async () => {
      const { app: built, cookie } = await freshApp();

      const propose = await built.server.inject({
        method: 'POST',
        url: `/skills/vskill-b-${uniq}/versions`,
        headers: { cookie },
        payload: { content: skillFor(`vskill-b-${uniq}`) },
      });
      expect(propose.statusCode).toBe(201);
      const proposed = propose.json() as { version: { version: number; status: string } };
      expect(proposed.version.status).toBe('proposed');
      expect(proposed.version.version).toBe(1);

      // No live file was ever written — the skill doesn't show up in a normal GET.
      const get = await built.server.inject({
        method: 'GET',
        url: `/skills/vskill-b-${uniq}`,
        headers: { cookie },
      });
      expect(get.statusCode).toBe(404);

      const list = await built.server.inject({
        method: 'GET',
        url: '/skills',
        headers: { cookie },
      });
      expect(list.json()).toEqual({ skills: [] });
    });

    it('activating a proposed version promotes it and writes the live file', async () => {
      const { app: built, cookie } = await freshApp();

      const propose = await built.server.inject({
        method: 'POST',
        url: `/skills/vskill-c-${uniq}/versions`,
        headers: { cookie },
        payload: { content: skillFor(`vskill-c-${uniq}`) },
      });
      expect(propose.statusCode).toBe(201);

      const activate = await built.server.inject({
        method: 'POST',
        url: `/skills/vskill-c-${uniq}/versions/1/activate`,
        headers: { cookie },
      });
      expect(activate.statusCode).toBe(200);
      const activated = activate.json() as { version: { status: string } };
      expect(activated.version.status).toBe('active');

      const get = await built.server.inject({
        method: 'GET',
        url: `/skills/vskill-c-${uniq}`,
        headers: { cookie },
      });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({
        name: `vskill-c-${uniq}`,
        content: skillFor(`vskill-c-${uniq}`),
      });
    });

    it('rejecting a proposed version marks it rejected and never touches the live file', async () => {
      const { app: built, cookie } = await freshApp();

      await built.server.inject({
        method: 'POST',
        url: `/skills/vskill-d-${uniq}/versions`,
        headers: { cookie },
        payload: { content: skillFor(`vskill-d-${uniq}`) },
      });

      const reject = await built.server.inject({
        method: 'POST',
        url: `/skills/vskill-d-${uniq}/versions/1/reject`,
        headers: { cookie },
      });
      expect(reject.statusCode).toBe(200);
      const rejected = reject.json() as { version: { status: string } };
      expect(rejected.version.status).toBe('rejected');

      const get = await built.server.inject({
        method: 'GET',
        url: `/skills/vskill-d-${uniq}`,
        headers: { cookie },
      });
      expect(get.statusCode).toBe(404);

      // Re-rejecting (already-rejected, not proposed) is a 404, not a silent success.
      const rejectAgain = await built.server.inject({
        method: 'POST',
        url: `/skills/vskill-d-${uniq}/versions/1/reject`,
        headers: { cookie },
      });
      expect(rejectAgain.statusCode).toBe(404);
    });

    it('requires auth on every mutating version route', async () => {
      const { app: built } = await freshApp();

      const propose = await built.server.inject({
        method: 'POST',
        url: `/skills/vskill-e-${uniq}/versions`,
        payload: { content: skillFor(`vskill-e-${uniq}`) },
      });
      expect(propose.statusCode).toBe(401);

      const list = await built.server.inject({
        method: 'GET',
        url: `/skills/vskill-e-${uniq}/versions`,
      });
      expect(list.statusCode).toBe(401);

      const activate = await built.server.inject({
        method: 'POST',
        url: `/skills/vskill-e-${uniq}/versions/1/activate`,
      });
      expect(activate.statusCode).toBe(401);

      const reject = await built.server.inject({
        method: 'POST',
        url: `/skills/vskill-e-${uniq}/versions/1/reject`,
      });
      expect(reject.statusCode).toBe(401);

      const evaluate = await built.server.inject({
        method: 'POST',
        url: `/skills/vskill-e-${uniq}/versions/1/evaluate`,
        payload: { testSet: [{ task: 'x' }], providers: ['claude'] },
      });
      expect(evaluate.statusCode).toBe(401);
    });

    it('rejects a path-traversal-shaped name on every new version route', async () => {
      const { app: built, cookie } = await freshApp();
      const bad = encodeURIComponent('../../etc/passwd');

      const propose = await built.server.inject({
        method: 'POST',
        url: `/skills/${bad}/versions`,
        headers: { cookie },
        payload: { content: skillFor(`vskill-e-${uniq}`) },
      });
      expect(propose.statusCode).toBe(400);

      const list = await built.server.inject({
        method: 'GET',
        url: `/skills/${bad}/versions`,
        headers: { cookie },
      });
      expect(list.statusCode).toBe(400);

      const activate = await built.server.inject({
        method: 'POST',
        url: `/skills/${bad}/versions/1/activate`,
        headers: { cookie },
      });
      expect(activate.statusCode).toBe(400);

      const reject = await built.server.inject({
        method: 'POST',
        url: `/skills/${bad}/versions/1/reject`,
        headers: { cookie },
      });
      expect(reject.statusCode).toBe(400);

      const evaluate = await built.server.inject({
        method: 'POST',
        url: `/skills/${bad}/versions/1/evaluate`,
        headers: { cookie },
        payload: { testSet: [{ task: 'x' }], providers: ['claude'] },
      });
      expect(evaluate.statusCode).toBe(400);
    });

    it('evaluate responds 501 when no executor is configured', async () => {
      const { app: built, cookie } = await freshApp();

      await built.server.inject({
        method: 'PUT',
        url: `/skills/vskill-g-${uniq}`,
        headers: { cookie },
        payload: { content: skillFor(`vskill-g-${uniq}`) },
      });

      const evaluate = await built.server.inject({
        method: 'POST',
        url: `/skills/vskill-g-${uniq}/versions/1/evaluate`,
        headers: { cookie },
        payload: { testSet: [{ task: 'x' }], providers: ['claude'] },
      });
      expect(evaluate.statusCode).toBe(501);
    });
  });
});
