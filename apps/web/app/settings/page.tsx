'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Nav from '../../components/Nav';
import {
  deleteCredential,
  listCredentials,
  me,
  putCredential,
  type CredentialSummary,
} from '../../lib/api';

const PROVIDERS: {
  id: string;
  label: string;
  description: string;
  free: boolean;
  placeholder: string;
}[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'Local/self-hosted. No API key needed — configure OLLAMA_URL in .env.',
    free: true,
    placeholder: '',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Free tier at ai.google.dev (15 RPM). Paid plans available.',
    free: true,
    placeholder: 'AIza...',
  },
  {
    id: 'claude',
    label: 'Claude (Anthropic)',
    description: 'Requires a paid API key from console.anthropic.com.',
    free: false,
    placeholder: 'sk-ant-...',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'Affordable API at platform.deepseek.com.',
    free: false,
    placeholder: 'sk-...',
  },
  {
    id: 'grok',
    label: 'Grok (x.ai)',
    description: 'API from console.x.ai.',
    free: false,
    placeholder: 'xai-...',
  },
];

function ProviderCard({
  provider,
  credential,
  onSaved,
}: {
  provider: (typeof PROVIDERS)[number];
  credential: CredentialSummary | undefined;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOllama = provider.id === 'ollama';
  const isConfigured = isOllama || credential !== undefined;

  async function handleSave(): Promise<void> {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    const result = await putCredential(provider.id, apiKey);
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setApiKey('');
    setEditing(false);
    onSaved();
  }

  async function handleDelete(): Promise<void> {
    setDeleting(true);
    await deleteCredential(provider.id);
    setDeleting(false);
    onSaved();
  }

  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-medium">{provider.label}</h3>
            {provider.free && (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900 dark:text-green-300">
                Free
              </span>
            )}
            {isConfigured && (
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900 dark:text-blue-300">
                Connected
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-neutral-500">{provider.description}</p>
        </div>
      </div>

      {isOllama ? (
        <p className="mt-3 text-xs text-neutral-400">
          Ollama connects via OLLAMA_URL in your .env — no key to add here.
        </p>
      ) : editing ? (
        <div className="mt-3 flex flex-col gap-2">
          <input
            type="password"
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            placeholder={provider.placeholder}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoFocus
          />
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={saving || !apiKey.trim()}
              onClick={() => void handleSave()}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {saving ? 'Saving…' : 'Save key'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setApiKey('');
                setError(null);
              }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            {credential ? 'Update key' : 'Add key'}
          </button>
          {credential && (
            <button
              type="button"
              disabled={deleting}
              onClick={() => void handleDelete()}
              className="rounded-md border border-red-300 px-3 py-1.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            >
              {deleting ? 'Removing…' : 'Remove'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function SettingsPage(): React.JSX.Element | null {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);

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

  function loadCredentials(): void {
    void listCredentials()
      .then(setCredentials)
      .catch(() => setCredentials([]));
  }

  useEffect(() => {
    if (authChecked) loadCredentials();
  }, [authChecked]);

  if (authError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">{authError}</p>
      </main>
    );
  }

  if (!authChecked) return null;

  const credentialMap = new Map(credentials.map((c) => [c.provider, c]));

  return (
    <>
      <Nav current="/settings" />
      <main className="mx-auto max-w-2xl px-6 py-12">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Manage your provider API keys. Keys are encrypted at rest and never leave
          this instance.
        </p>
      </div>

      <section className="mt-8">
        <h2 className="mb-4 text-lg font-medium">Providers</h2>
        <div className="flex flex-col gap-3">
          {PROVIDERS.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              credential={credentialMap.get(provider.id)}
              onSaved={loadCredentials}
            />
          ))}
        </div>
      </section>
      </main>
    </>
  );
}
