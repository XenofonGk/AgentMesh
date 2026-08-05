'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { parseSkillMarkdown } from '@agentmesh/skills/parser';
import {
  activateSkillVersion,
  deleteSkill,
  getSkill,
  listSkillVersions,
  me,
  rejectSkillVersion,
  saveSkill,
  type SkillVersion,
} from '../../../lib/api';

/**
 * VERSION history list for this skill, with GATE actions. A simple list, not a diff
 * viewer — proportionate to the rest of this app's UI (task instructions).
 */
function VersionHistory({ name }: { name: string }): React.JSX.Element {
  const [versions, setVersions] = useState<SkillVersion[] | null>(null);
  const [busyVersion, setBusyVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void listSkillVersions(name)
      .then(setVersions)
      .catch(() => {
        setError('Failed to load version history.');
      });
  }, [name]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleActivate(version: number): Promise<void> {
    setBusyVersion(version);
    try {
      const ok = await activateSkillVersion(name, version);
      if (!ok) {
        setError('Failed to activate that version.');
        return;
      }
      refresh();
    } finally {
      setBusyVersion(null);
    }
  }

  async function handleReject(version: number): Promise<void> {
    setBusyVersion(version);
    try {
      const ok = await rejectSkillVersion(name, version);
      if (!ok) {
        setError('Failed to reject that version.');
        return;
      }
      refresh();
    } finally {
      setBusyVersion(null);
    }
  }

  if (versions === null) {
    return <p className="text-sm text-neutral-500">Loading version history…</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold tracking-tight">Version history</h2>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {versions.length === 0 ? (
        <p className="text-sm text-neutral-500">No recorded versions yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {versions.map((v) => (
            <li
              key={v.id}
              className="flex flex-col gap-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700"
            >
              <div className="flex items-center justify-between gap-2">
                <span>
                  v{v.version} —{' '}
                  <span
                    className={
                      v.status === 'active'
                        ? 'text-green-700 dark:text-green-400'
                        : v.status === 'rejected'
                          ? 'text-neutral-500'
                          : 'text-amber-600 dark:text-amber-400'
                    }
                  >
                    {v.status}
                  </span>
                </span>
                <span className="text-xs text-neutral-500">
                  {new Date(v.createdAt).toLocaleString()}
                </span>
              </div>
              {v.evalResult !== null && v.evalResult !== undefined && (
                <pre className="overflow-x-auto rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-800">
                  {JSON.stringify(v.evalResult, null, 2)}
                </pre>
              )}
              {v.status === 'proposed' && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busyVersion === v.version}
                    onClick={() => void handleActivate(v.version)}
                    className="rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
                  >
                    Activate
                  </button>
                  <button
                    type="button"
                    disabled={busyVersion === v.version}
                    onClick={() => void handleReject(v.version)}
                    className="rounded-md border border-red-600 px-3 py-1 text-xs text-red-700 disabled:opacity-50 dark:text-red-400"
                  >
                    Reject
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Same debounced live-validation as `skills/page.tsx` — see that file's comment. */
function useLiveValidation(content: string): { ok: boolean; message: string | null } {
  const [result, setResult] = useState<{ ok: boolean; message: string | null }>({
    ok: false,
    message: null,
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      const parsed = parseSkillMarkdown(content, 'draft');
      setResult(
        parsed.ok
          ? { ok: true, message: null }
          : {
              ok: false,
              message:
                'message' in parsed.error
                  ? parsed.error.message
                  : `${parsed.error.kind.replace(/_/g, ' ')}`,
            },
      );
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [content]);

  return result;
}

export default function EditSkillPage(): React.JSX.Element | null {
  const router = useRouter();
  const params = useParams<{ name: string }>();
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const live = useLiveValidation(content ?? '');

  useEffect(() => {
    void me()
      .then((user) => {
        if (!user) {
          router.replace('/login');
          return;
        }
        setAuthChecked(true);
      })
      .catch(() => {
        setAuthError('Could not reach the API. Is it running?');
      });
  }, [router]);

  useEffect(() => {
    if (!authChecked) return;
    void getSkill(params.name)
      .then((skill) => {
        if (!skill) {
          setLoadError('Skill not found.');
          return;
        }
        setContent(skill.content);
      })
      .catch(() => {
        setLoadError('Failed to load the skill.');
      });
  }, [authChecked, params.name]);

  async function handleSave(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (content === null) return;
    setSaveError(null);
    setSaving(true);
    try {
      const result = await saveSkill(params.name, content);
      if (!result.ok) {
        setSaveError(result.message ?? result.error);
      }
    } catch {
      setSaveError('Failed to save the skill.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setDeleting(true);
    try {
      const ok = await deleteSkill(params.name);
      if (ok) {
        router.push('/skills');
        return;
      }
      setSaveError('Failed to delete the skill.');
    } finally {
      setDeleting(false);
    }
  }

  if (authError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">{authError}</p>
      </main>
    );
  }

  if (!authChecked) return null;

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
        <a href="/skills" className="text-sm text-neutral-500 hover:underline">
          ← back to skills
        </a>
      </main>
    );
  }

  if (content === null) return <main className="p-6">Loading…</main>;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">{params.name}</h1>
        <a href="/skills" className="text-sm text-neutral-500 hover:underline">
          ← back
        </a>
      </div>

      <form className="flex flex-col gap-4" onSubmit={(event) => void handleSave(event)}>
        <label className="flex flex-col gap-1 text-sm">
          SKILL.md
          <textarea
            className="min-h-96 rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
            required
            value={content}
            onChange={(event) => {
              setContent(event.target.value);
            }}
          />
        </label>

        <p
          className={`text-sm ${live.ok ? 'text-green-700 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}
        >
          {live.ok ? 'Looks valid.' : (live.message ?? 'Validating…')}
        </p>

        {saveError && (
          <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
        )}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={() => void handleDelete()}
            className="rounded-md border border-red-600 px-4 py-2 text-sm text-red-700 disabled:opacity-50 dark:text-red-400"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </form>

      <VersionHistory name={params.name} />
    </main>
  );
}
