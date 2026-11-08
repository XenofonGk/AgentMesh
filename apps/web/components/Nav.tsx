'use client';

import { useState } from 'react';
import {
  ChatBubblesIcon,
  GearIcon,
  HistoryIcon,
  LogoMark,
  MenuIcon,
  PlusCircleIcon,
  SkillIcon,
  XIcon,
} from './icons';

/**
 * The app shell every authenticated page renders first. A left rail, not the single
 * top-bar line this used to be — every page previously rolled its own ad-hoc "← Back"
 * link to a different place before the first version of this component unified them;
 * this pass gives that same unified nav the persistent, always-visible treatment
 * LobeChat/Open WebUI use, since a one-line top bar reads as an afterthought next to
 * those. `position: fixed`, not a flex sibling: every page keeps its own `<Nav/>` +
 * `<main/>` JSX unchanged (just offsetting `<main>` with `md:pl-60`), rather than every
 * page needing a new wrapping layout element.
 */
const LINKS: { href: string; label: string; icon: (p: { className?: string }) => React.JSX.Element }[] = [
  { href: '/', label: 'New run', icon: PlusCircleIcon },
  { href: '/runs', label: 'Runs', icon: HistoryIcon },
  { href: '/chat', label: 'Group chat', icon: ChatBubblesIcon },
  { href: '/settings', label: 'Settings', icon: GearIcon },
  { href: '/skills', label: 'Skills', icon: SkillIcon },
];

function Brand(): React.JSX.Element {
  return (
    <a href="/" className="flex items-center gap-2 px-1 text-neutral-900 dark:text-neutral-100">
      <LogoMark className="size-5 text-neutral-900 dark:text-neutral-100" />
      <span className="font-semibold tracking-tight">AgentMesh</span>
    </a>
  );
}

function NavLinks({ current, onNavigate }: { current: string; onNavigate?: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      {LINKS.map((link) => {
        const active = link.href === current;
        const Icon = link.icon;
        return (
          <a
            key={link.href}
            href={link.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
              active
                ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-100'
            }`}
          >
            <Icon className="size-4 shrink-0" />
            <span className="font-medium">{link.label}</span>
          </a>
        );
      })}
    </div>
  );
}

export default function Nav({ current }: { current: string }): React.JSX.Element {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Desktop rail — hidden below md, where the slim mobile bar + drawer take over. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col gap-6 border-r border-neutral-200 bg-white px-3 py-4 md:flex dark:border-neutral-800 dark:bg-neutral-950">
        <Brand />
        <NavLinks current={current} />
      </aside>

      {/* Mobile bar — brand + hamburger. The drawer below is the sidebar's mobile form,
          not a second nav: same `NavLinks`, same active state. */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 md:hidden dark:border-neutral-800 dark:bg-neutral-950">
        <Brand />
        <button
          type="button"
          onClick={() => {
            setMobileOpen(true);
          }}
          aria-label="Open navigation"
          className="rounded-md p-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
        >
          <MenuIcon className="size-5" />
        </button>
      </header>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => {
              setMobileOpen(false);
            }}
            className="absolute inset-0 bg-neutral-900/40"
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col gap-6 border-r border-neutral-200 bg-white px-3 py-4 dark:border-neutral-800 dark:bg-neutral-950">
            <div className="flex items-center justify-between">
              <Brand />
              <button
                type="button"
                onClick={() => {
                  setMobileOpen(false);
                }}
                aria-label="Close navigation"
                className="rounded-md p-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
              >
                <XIcon className="size-4" />
              </button>
            </div>
            <NavLinks
              current={current}
              onNavigate={() => {
                setMobileOpen(false);
              }}
            />
          </aside>
        </div>
      )}
    </>
  );
}
