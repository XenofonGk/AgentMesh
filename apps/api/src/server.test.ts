import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, type App } from './server.js';
import { loadConfig } from './config.js';
import type { DatabaseHandle } from '@agentmesh/db';

const config = loadConfig({
  DATABASE_URL: 'postgres://unused',
  WEB_ORIGIN: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
});

function fakeDatabase(up: boolean): DatabaseHandle {
  return {
    db: null as never,
    ping: () => Promise.resolve(up),
    close: () => Promise.resolve(),
  };
}

let app: App | undefined;
afterEach(async () => {
  await app?.server.close();
  app = undefined;
});

describe('server', () => {
  it('reports liveness without touching the database', async () => {
    app = await buildServer({ config, database: fakeDatabase(false) });
    const response = await app.server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports ready when the database answers', async () => {
    app = await buildServer({ config, database: fakeDatabase(true) });
    const response = await app.server.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', database: 'up' });
  });

  it('reports 503 when the database is unreachable', async () => {
    app = await buildServer({ config, database: fakeDatabase(false) });
    const response = await app.server.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
  });
});
