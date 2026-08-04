'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseSkillMarkdown } from '@agentmesh/skills';
import { listSkills, me, saveSkill, type SkillSummary } from '../../lib/api';

const DEFAULT_CONTENT = `---
name: my-skill
description: Describe what this skill does and when to use it.
---

Instructions for the agent go here.
`;

/** Debounces `parseSkillMarkdown` on every keystroke — the "live" half of Phase 4's
 *  live validation. The server (`apps/api/src/skills/routes.ts`) re-runs the same
 *  parser on submit; this is UX only, never the actual gate. */
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

export default function SkillsPage(): React.JSX.Element | null {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [content, setContent] = useState(DEFAULT_CONTENT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const live = useLiveValidation(content);

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
    void listSkills()
      .then(setSkills)
      .catch(() => {
        setListError('Failed to load skills.');
      });
  }, [authChecked]);

  async function handleCreate(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaveError(null);
    setSaving(true);
    try {
      const result = await saveSkill(name, content);
      if (!result.ok) {
        setSaveError(result.message ?? result.error);
        return;
      }
      router.push(`/skills/${encodeURIComponent(name)}`);
    } catch {
      setSaveError('Failed to save the skill.');
    } finally {
      setSaving(false);
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

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Skills</h1>
          <p className="mt-2 text-neutral-600 dark:text-neutral-400">
            Agent Skills authored for this instance, from `AGENTMESH_SKILLS_DIR`.
          </p>
        </div>
        <a href="/" className="text-sm text-neutral-500 hover:underline">
          ← back
        </a>
      </div>

      {listError && <p className="text-sm text-red-600 dark:text-red-400">{listError}</p>}

      {skills && (
        <ul className="flex flex-col gap-2">
          {skills.length === 0 && (
            <li className="text-sm text-neutral-500">No skills yet.</li>
          )}
          {skills.map((skill) => (
            <li key={skill.name}>
              <a
                href={`/skills/${encodeURIComponent(skill.name)}`}
                className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
              >
                <span>
                  <span className="font-medium">{skill.name}</span>
                  {skill.description && (
                    <span className="ml-2 text-neutral-500">{skill.description}</span>
                  )}
                </span>
                {!skill.valid && (
                  <span className="text-xs font-medium text-red-600 dark:text-red-400">
                    invalid
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}

      {!showCreate ? (
        <button
          type="button"
          onClick={() => {
            setShowCreate(true);
          }}
          className="self-start rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          New skill
        </button>
      ) : (
        <form
          className="flex flex-col gap-4 rounded-md border border-neutral-200 p-4 dark:border-neutral-800"
          onSubmit={(event) => void handleCreate(event)}
        >
          <label className="flex flex-col gap-1 text-sm">
            Name (kebab-case)
            <input
              className="rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
              required
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              placeholder="my-skill"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            SKILL.md
            <textarea
              className="min-h-64 rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
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
              onClick={() => {
                setShowCreate(false);
              }}
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
