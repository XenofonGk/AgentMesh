export { createDatabase } from './client.js';
export type { Database, DatabaseHandle } from './client.js';
export { runMigrations } from './migrate.js';
export * as schema from './schema.js';
export {
  Vault,
  VaultBootError,
  loadMasterKey,
  MasterKeyError,
  withSecret,
} from './vault/index.js';
export type { MasterKey, VaultFailure, CredentialSummary } from './vault/index.js';
export { wipe } from './vault/index.js';
export {
  hashPassword,
  verifyPassword,
  login,
  createUserWithPassword,
  createSession,
  validateSession,
  revokeSession,
  revokeAllSessions,
  tokensEqual,
  seedAdmin,
  AdminSeedError,
  PLACEHOLDER_ADMIN_PASSWORD,
} from './auth/index.js';
export type { LoginFailure, Session } from './auth/index.js';
