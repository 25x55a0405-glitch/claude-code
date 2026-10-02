export function relTime(isoStr: string | undefined): string {
  if (!isoStr) return '';
  const diff = (new Date(isoStr).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const fmt = (n: number, u: string) => {
    const v = Math.round(n);
    return diff < 0 ? `${v}${u} ago` : `in ${v}${u}`;
  };
  if (abs < 45) return diff < 0 ? 'just now' : 'in a moment';
  if (abs < 3600) return fmt(abs / 60, 'm');
  if (abs < 86400) return fmt(abs / 3600, 'h');
  return fmt(abs / 86400, 'd');
}

export function clockTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function dayLabel(isoStr: string): string {
  const d = new Date(isoStr);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

/** Tiny, safe markdown: **bold**, `code`, line breaks. */
export function renderInline(text: string): (string | { b?: string; code?: string })[] {
  const out: (string | { b?: string; code?: string })[] = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] !== undefined ? { b: m[1] } : { code: m[2] });
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** "4.2 KB", for file sizes. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
