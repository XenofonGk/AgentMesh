'use client';

/**
 * One small top nav shared by every authenticated page. Each page previously rolled
 * its own ad-hoc "← Back" link to a different place — this replaces all of them with
 * one consistent set of destinations.
 */
const LINKS: { href: string; label: string }[] = [
  { href: '/', label: 'New run' },
  { href: '/runs', label: 'Runs' },
  { href: '/chat', label: 'Group chat' },
  { href: '/settings', label: 'Settings' },
  { href: '/skills', label: 'Skills' },
];

export default function Nav({ current }: { current: string }): React.JSX.Element {
  return (
    <nav className="flex items-center gap-4 border-b border-neutral-200 px-6 py-3 text-sm dark:border-neutral-800">
      <span className="font-semibold tracking-tight">AgentMesh</span>
      <div className="flex gap-4">
        {LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className={
              link.href === current
                ? 'font-medium text-neutral-900 dark:text-neutral-100'
                : 'text-neutral-500 hover:underline'
            }
          >
            {link.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
