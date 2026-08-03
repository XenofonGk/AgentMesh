const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">AgentMesh</h1>
        <p className="mt-2 text-neutral-600 dark:text-neutral-400">
          Self-hosted control plane for running AI coding agents across providers. You
          bring your own credentials; they never leave this instance.
        </p>
      </div>

      <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <p className="font-medium">Phase 0 — foundations</p>
        <p className="mt-1 text-neutral-600 dark:text-neutral-400">
          The stack is up and empty. API readiness:{' '}
          <a
            className="underline underline-offset-4"
            href={`${API_URL}/readyz`}
            rel="noreferrer"
          >
            {API_URL}/readyz
          </a>
        </p>
      </div>
    </main>
  );
}
