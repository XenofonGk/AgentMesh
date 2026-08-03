import type { NextConfig } from 'next';

const config: NextConfig = {
  // Emits a self-contained server bundle so the runtime image needs no node_modules.
  output: 'standalone',
  reactStrictMode: true,
};

// Next's own telemetry is disabled via NEXT_TELEMETRY_DISABLED=1 in the Dockerfile and
// .env.example — AgentMesh phones home to nobody (CLAUDE.md → anti-goals).

export default config;
