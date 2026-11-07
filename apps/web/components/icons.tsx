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
