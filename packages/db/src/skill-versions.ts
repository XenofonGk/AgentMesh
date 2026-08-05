/**
 * VERSION step of the improvement loop (PLAN.md §6). See `schema.ts`'s comment on
 * `skillVersions` for the shape and why it exists. This module is the only place that
 * inserts/updates rows in that table — `apps/api/src/skills/routes.ts` calls through
 * here rather than touching the table directly, same layering as `run-grants.ts`.
 *
 * Nothing here touches the filesystem. Writing the live `SKILL.md` (or not) is the
 * caller's job — this module only ever answers "what does the version history say,"
 * and the caller (the API route) is what CLAUDE.md's "a human approves before it goes
 * live" applies to: `activateVersion` here is a pure DB transition, and the route that
 * calls it is the only thing a human triggers.
 */
import { and, desc, eq, max } from 'drizzle-orm';
import type { Database } from './client.js';
import { skillVersions } from './schema.js';

export type SkillVersionStatus = 'proposed' | 'active' | 'rejected';

export interface SkillVersionRow {
  id: string;
  skillName: string;
  version: number;
  content: string;
  status: SkillVersionStatus;
  createdBy: string | null;
  createdAt: Date;
  activatedAt: Date | null;
  evalResult: unknown;
}

/**
 * Records a new version row for `skillName`. `activate: true` immediately marks it
 * `'active'` (the in-app editor's normal save path — a human editing directly is
 * already the gate); `activate: false` lands it `'proposed'` (the PROPOSE route),
 * requiring an explicit later call to `activateVersion`.
 *
 * Version numbers are a per-skill sequence assigned here, never client-supplied.
 * Activating deactivates any prior active version for the same name in the same
 * transaction, so the partial unique index (`schema.ts`) is never violated.
 */
export async function createSkillVersion(
  db: Database,
  args: {
    skillName: string;
    content: string;
    createdBy: string | null;
    activate: boolean;
  },
): Promise<SkillVersionRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ max: max(skillVersions.version) })
      .from(skillVersions)
      .where(eq(skillVersions.skillName, args.skillName));
    const nextVersion = (row?.max ?? 0) + 1;

    if (args.activate) {
      await tx
        .update(skillVersions)
        .set({ status: 'rejected' })
        .where(
          and(eq(skillVersions.skillName, args.skillName), eq(skillVersions.status, 'active')),
        );
    }

    const now = new Date();
    const [inserted] = await tx
      .insert(skillVersions)
      .values({
        skillName: args.skillName,
        version: nextVersion,
        content: args.content,
        status: args.activate ? 'active' : 'proposed',
        createdBy: args.createdBy,
        ...(args.activate && { activatedAt: now }),
      })
      .returning();

    if (!inserted) {
      throw new Error('failed to insert skill version');
    }
    return inserted as SkillVersionRow;
  });
}

/** All versions of a skill, newest first — what the version-history UI lists. */
export async function listSkillVersions(
  db: Database,
  skillName: string,
): Promise<SkillVersionRow[]> {
  const rows = await db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillName, skillName))
    .orderBy(desc(skillVersions.version));
  return rows as SkillVersionRow[];
}

/** One specific version, or null if it doesn't exist. */
export async function getSkillVersion(
  db: Database,
  skillName: string,
  version: number,
): Promise<SkillVersionRow | null> {
  const [row] = await db
    .select()
    .from(skillVersions)
    .where(and(eq(skillVersions.skillName, skillName), eq(skillVersions.version, version)));
  return (row as SkillVersionRow | undefined) ?? null;
}

/** The version currently live on disk, per the version-history table — or null. */
export async function getActiveSkillVersion(
  db: Database,
  skillName: string,
): Promise<SkillVersionRow | null> {
  const [row] = await db
    .select()
    .from(skillVersions)
    .where(and(eq(skillVersions.skillName, skillName), eq(skillVersions.status, 'active')));
  return (row as SkillVersionRow | undefined) ?? null;
}

/**
 * GATE: promotes a `'proposed'` version to `'active'`, demoting whatever was active
 * before it. Returns null if the version doesn't exist or isn't `'proposed'` — the
 * caller (route) is what decides that's a 400/404, this module just refuses silently.
 * Writing the live `SKILL.md` is the caller's job, done only after this succeeds.
 */
export async function activateSkillVersion(
  db: Database,
  skillName: string,
  version: number,
): Promise<SkillVersionRow | null> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillName, skillName), eq(skillVersions.version, version)));
    if (!existing || existing.status !== 'proposed') {
      return null;
    }

    await tx
      .update(skillVersions)
      .set({ status: 'rejected' })
      .where(and(eq(skillVersions.skillName, skillName), eq(skillVersions.status, 'active')));

    const [updated] = await tx
      .update(skillVersions)
      .set({ status: 'active', activatedAt: new Date() })
      .where(and(eq(skillVersions.skillName, skillName), eq(skillVersions.version, version)))
      .returning();

    return (updated as SkillVersionRow | undefined) ?? null;
  });
}

/**
 * GATE: marks a `'proposed'` version `'rejected'` without ever touching the live file.
 * Returns null if the version doesn't exist or isn't `'proposed'`.
 */
export async function rejectSkillVersion(
  db: Database,
  skillName: string,
  version: number,
): Promise<SkillVersionRow | null> {
  const [updated] = await db
    .update(skillVersions)
    .set({ status: 'rejected' })
    .where(
      and(
        eq(skillVersions.skillName, skillName),
        eq(skillVersions.version, version),
        eq(skillVersions.status, 'proposed'),
      ),
    )
    .returning();
  return (updated as SkillVersionRow | undefined) ?? null;
}

/** EVALUATE integration: attaches an eval report to a version row for the GATE to read. */
export async function recordSkillVersionEvalResult(
  db: Database,
  skillName: string,
  version: number,
  evalResult: unknown,
): Promise<void> {
  await db
    .update(skillVersions)
    .set({ evalResult })
    .where(and(eq(skillVersions.skillName, skillName), eq(skillVersions.version, version)));
}
