import Docker from 'dockerode';
import { loadConfig } from './config.js';
import { buildBrokerServer } from './server.js';
import { DockerSandboxProvider } from './docker-sandbox-provider.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const sandbox = new DockerSandboxProvider({ docker: new Docker() });

  const { server } = await buildBrokerServer({
    sandbox,
    workspaceRoot: config.WORKSPACE_ROOT,
    runnerNetwork: config.RUNNER_NETWORK,
    logLevel: config.LOG_LEVEL,
  });

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, 'shutting down');
    await server.close();
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  await server.listen({ host: config.BROKER_HOST, port: config.BROKER_PORT });
}

main().catch((error: unknown) => {
  console.error(
    'Broker failed to start:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
