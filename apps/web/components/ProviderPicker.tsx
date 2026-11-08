import { roleColor } from '../lib/roleColor';

/**
 * A chip-style multi-select, replacing the raw checkbox list every provider-selection
 * form used to roll separately. Each chip's initial-circle uses the same color token
 * as `Avatar`/the chat transcript (`roleColor.ts`) so a provider reads as the same
 * "person" everywhere in the app — not `Avatar` itself, since a selected chip inverts
 * to a solid fill that the tinted avatar treatment doesn't have a variant for.
 */
export default function ProviderPicker({
  providers,
  selected,
  configured,
  onToggle,
}: {
  providers: readonly string[];
  selected: readonly string[];
  /** `null` while credentials are still loading — chips render enabled-but-unbadged
   *  rather than flash a "no key" badge on every provider for a moment. */
  configured: ReadonlySet<string> | null;
  onToggle: (provider: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      {providers.map((provider) => {
        const isSelected = selected.includes(provider);
        const isConfigured = configured?.has(provider) ?? true;
        const color = roleColor(provider);
        return (
          <button
            key={provider}
            type="button"
            aria-pressed={isSelected}
            onClick={() => {
              onToggle(provider);
            }}
            className={`group flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm transition-colors ${
              isSelected
                ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900'
                : 'border-neutral-300 bg-white text-neutral-700 hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-neutral-600'
            }`}
          >
            <span
              className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                isSelected ? 'bg-white/20 text-white dark:bg-neutral-900/10 dark:text-neutral-900' : `${color.avatarBg} ${color.avatarText}`
              }`}
              aria-hidden="true"
            >
              {provider.charAt(0).toUpperCase()}
            </span>
            {provider}
            {!isConfigured && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  isSelected
                    ? 'bg-white/20 text-white dark:bg-neutral-900/10 dark:text-neutral-900'
                    : 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300'
                }`}
              >
                no key
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
