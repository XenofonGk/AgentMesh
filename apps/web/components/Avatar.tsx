import { roleColor } from '../lib/roleColor';

/** A single initial in a tinted circle — same approach Slack/Linear use for a
 *  participant with no photo. No photo exists for any chat participant here
 *  (a user or a model), so this is the only avatar this app ever needs. */
export default function Avatar({
  role,
  size = 'md',
}: {
  role: string;
  size?: 'sm' | 'md';
}): React.JSX.Element {
  const color = roleColor(role);
  const dimension = size === 'sm' ? 'size-6 text-[11px]' : 'size-8 text-xs';
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold ${dimension} ${color.avatarBg} ${color.avatarText}`}
      aria-hidden="true"
    >
      {role.charAt(0).toUpperCase()}
    </div>
  );
}
