'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { parseSkillMarkdown } from '@agentmesh/skills';
import { deleteSkill, getSkill, me, saveSkill } from '../../../lib/api';

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

        {saveError && <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>}

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
    </main>
  );
}
