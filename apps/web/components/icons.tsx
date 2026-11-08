/**
 * Every icon in the app comes from here — one consistent stroke weight (1.75),
 * round caps/joins, 20px viewBox — so nothing reads as a mismatched set pulled
 * from different places. No emoji standing in for an icon anywhere in the UI.
 */
function base(children: React.ReactNode, className?: string): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'size-4'}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function SendIcon({ className }: { className?: string }): React.JSX.Element {
  return base(<path d="M17 3 9 11M17 3l-5.5 14-3-6-6-3L17 3Z" />, className);
}

export function StopIcon({ className }: { className?: string }): React.JSX.Element {
  return base(<rect x="5" y="5" width="10" height="10" rx="2" />, className);
}

export function AlertIcon({ className }: { className?: string }): React.JSX.Element {
  return base(
    <>
      <path d="M10 3 2 17h16L10 3Z" />
      <path d="M10 8.5v3.2" />
      <circle cx="10" cy="14.2" r="0.15" fill="currentColor" stroke="none" />
    </>,
    className,
  );
}

export function TrashIcon({ className }: { className?: string }): React.JSX.Element {
  return base(
    <>
      <path d="M4 6h12" />
      <path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h1A1.5 1.5 0 0 1 12 4.5V6" />
      <path d="M5.5 6 6 16.5A1.5 1.5 0 0 0 7.5 18h5a1.5 1.5 0 0 0 1.5-1.5L14.5 6" />
    </>,
    className,
  );
}

export function PlusCircleIcon({ className }: { className?: string }): React.JSX.Element {
  return base(
    <>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 7v6M7 10h6" />
    </>,
    className,
  );
}

export function HistoryIcon({ className }: { className?: string }): React.JSX.Element {
  return base(
    <>
      <path d="M3.5 10a6.5 6.5 0 1 1 1.9 4.6" />
      <path d="M3.5 5.5v3.8h3.8" />
      <path d="M10 6.5v3.8l2.6 1.6" />
    </>,
    className,
  );
}

export function ChatBubblesIcon({ className }: { className?: string }): React.JSX.Element {
  return base(
    <>
      <path d="M3 5.5a1.5 1.5 0 0 1 1.5-1.5h6a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5H8l-2.8 2.1a.4.4 0 0 1-.65-.32V11H4.5A1.5 1.5 0 0 1 3 9.5v-4Z" />
      <path d="M13 8h2.5A1.5 1.5 0 0 1 17 9.5v4a1.5 1.5 0 0 1-1.5 1.5H15v1.78a.4.4 0 0 1-.65.32L12 15.2" />
    </>,
    className,
  );
}

export function GearIcon({ className }: { className?: string }): React.JSX.Element {
  return base(
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 3v1.6M10 15.4V17M17 10h-1.6M4.6 10H3M14.9 5.1l-1.13 1.13M6.23 13.67 5.1 14.9M14.9 14.9l-1.13-1.13M6.23 6.23 5.1 5.1" />
    </>,
    className,
  );
}

export function SkillIcon({ className }: { className?: string }): React.JSX.Element {
  return base(
    <>
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H10v14H5.5A1.5 1.5 0 0 1 4 15.5v-11Z" />
      <path d="M16 4.5A1.5 1.5 0 0 0 14.5 3H10v14h4.5a1.5 1.5 0 0 0 1.5-1.5v-11Z" />
    </>,
    className,
  );
}

export function MenuIcon({ className }: { className?: string }): React.JSX.Element {
  return base(<path d="M3 6h14M3 10h14M3 14h14" />, className);
}

export function XIcon({ className }: { className?: string }): React.JSX.Element {
  return base(<path d="M5 5l10 10M15 5 5 15" />, className);
}

export function KeyIcon({ className }: { className?: string }): React.JSX.Element {
  return base(
    <>
      <circle cx="7" cy="13" r="3.25" />
      <path d="M9.3 10.7 15.5 4.5M13 7l1.75 1.75M15.25 4.75 17 6.5" />
    </>,
    className,
  );
}

export function CheckIcon({ className }: { className?: string }): React.JSX.Element {
  return base(<path d="M4 10.5 8 14.5 16 5.5" />, className);
}

export function LogoMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      className={className ?? 'size-5'}
      aria-hidden="true"
    >
      <circle cx="5.5" cy="6" r="2.25" className="fill-current" />
      <circle cx="14.5" cy="6" r="2.25" className="fill-current" opacity="0.55" />
      <circle cx="10" cy="14" r="2.25" className="fill-current" opacity="0.8" />
      <path
        d="M5.5 8.1V12M14.5 8.1V12M7.5 7.2l5-.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
