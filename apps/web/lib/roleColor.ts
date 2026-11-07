/**
 * One color token per chat participant, shared by the avatar and the name label so
 * they never drift apart. `user` gets the app's own neutral accent (same inversion
 * used on every primary button); providers cycle a fixed, restrained palette keyed
 * by a hash of their name, so a given provider stays the same color turn to turn
 * without a color having to be hand-assigned per adapter.
 */
export interface RoleColor {
  avatarBg: string;
  avatarText: string;
  nameText: string;
}

const USER: RoleColor = {
  avatarBg: 'bg-neutral-900 dark:bg-white',
  avatarText: 'text-white dark:text-neutral-900',
  nameText: 'text-neutral-900 dark:text-neutral-100',
};

const PROVIDER_PALETTE: RoleColor[] = [
  {
    avatarBg: 'bg-blue-100 dark:bg-blue-950',
    avatarText: 'text-blue-700 dark:text-blue-400',
    nameText: 'text-blue-700 dark:text-blue-400',
  },
  {
    avatarBg: 'bg-purple-100 dark:bg-purple-950',
    avatarText: 'text-purple-700 dark:text-purple-400',
    nameText: 'text-purple-700 dark:text-purple-400',
  },
  {
    avatarBg: 'bg-emerald-100 dark:bg-emerald-950',
    avatarText: 'text-emerald-700 dark:text-emerald-400',
    nameText: 'text-emerald-700 dark:text-emerald-400',
  },
  {
    avatarBg: 'bg-orange-100 dark:bg-orange-950',
    avatarText: 'text-orange-700 dark:text-orange-400',
    nameText: 'text-orange-700 dark:text-orange-400',
  },
  {
    avatarBg: 'bg-pink-100 dark:bg-pink-950',
    avatarText: 'text-pink-700 dark:text-pink-400',
    nameText: 'text-pink-700 dark:text-pink-400',
  },
];

export function roleColor(role: string): RoleColor {
  if (role === 'user') return USER;
  let hash = 0;
  for (const char of role) hash = (hash * 31 + char.charCodeAt(0)) % PROVIDER_PALETTE.length;
  return PROVIDER_PALETTE[hash]!;
}
