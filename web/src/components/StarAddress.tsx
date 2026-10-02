import type { StarView } from '../api';
import { href } from '../lib/router';
import { Icon } from './Icon';
import { useToast } from './ui';

/** A Star's own email address: mail sent, forwarded or CC'd there becomes its task. */
export function StarAddress({ star, compact }: { star: StarView; compact?: boolean }) {
  const toast = useToast();
  if (star.email === undefined) return null;
  if (!star.email) {
    return compact ? null : (
      <p className="t3 xs">Connect Gmail in <a href={href('permissions')} style={{ textDecoration: 'underline' }}>Permissions</a> and {star.name} gets its own address on it.</p>
    );
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(star.email!); toast('Address copied'); } catch { toast('Couldn’t copy. Select it and copy instead.'); }
  };
  return (
    <div className={compact ? 'star-address compact' : 'col'} style={compact ? undefined : { gap: 6 }}>
      <div className="copy-row">
        <Icon name="send" size={14} />
        <code className="mono">{star.email}</code>
        <button className="btn sm" onClick={copy}>Copy</button>
      </div>
      {!compact && <p className="t3 xs">Send, forward or CC mail here and {star.name} takes it on, up to 10 an hour. Mail from you is a request; mail from anyone else is something to read, and {star.name} asks before acting on it. Renaming {star.name} keeps this address.</p>}
    </div>
  );
}
