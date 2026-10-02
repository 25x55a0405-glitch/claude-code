import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Approval, ConnectionStatus, StarView, TaskKind, TaskStatus } from '../api';
import { useAgent } from '../lib/agent';
import { Avatar } from './Avatar';
import { Icon, type IconName } from './Icon';

/** The user's own Sky, in its current state. */
export function Me({ size = 32, track = false, state }: { size?: number; track?: boolean; state?: 'idle' }) {
  const { status, settings } = useAgent();
  return (
    <Avatar
      size={size}
      track={track}
      state={state ?? status?.state ?? 'idle'}
      character={settings?.avatar.character}
      color={settings?.avatar.color}
    />
  );
}

/** One Star's face, in that Star's own state. */
export function StarFace({ star, size = 32, track = false, still = false }: { star: Pick<StarView, 'name' | 'avatar'> & { status?: StarView['status'] }; size?: number; track?: boolean; still?: boolean }) {
  const { status } = useAgent();
  const state = still ? 'idle' : status?.state === 'paused' ? 'paused' : star.status?.state ?? 'idle';
  return <Avatar size={size} track={track} state={state} character={star.avatar.character} color={star.avatar.color} label={star.name} />;
}

const statusChip: Record<TaskStatus, [string, string]> = {
  active: ['Working', 'live'],
  scheduled: ['Scheduled', ''],
  waiting_approval: ['Needs you', 'attn'],
  blocked: ['Blocked', 'warn'],
  paused: ['Paused', ''],
  done: ['Done', 'ok'],
  failed: ['Failed', 'danger'],
};

export function StatusChip({ status }: { status: TaskStatus }) {
  const [label, tone] = statusChip[status];
  return <span className={`chip ${tone}`}><span className="dot" />{label}</span>;
}

export const kindMeta: Record<TaskKind, { label: string; icon: IconName }> = {
  one_off: { label: 'One-off', icon: 'flag' },
  recurring: { label: 'Repeats', icon: 'repeat' },
  watch: { label: 'Watching', icon: 'eye' },
};

export function ConnectionChip({ status }: { status: ConnectionStatus }) {
  const [label, tone] = { connected: ['Connected', 'ok'], expired: ['Needs reconnecting', 'warn'], disconnected: ['Not connected', ''] }[status];
  return <span className={`chip ${tone}`}>{label}</span>;
}

export function ApprovalChip({ status }: { status: Approval['status'] }) {
  const [label, tone] = { pending: ['Waiting for you', 'attn'], approved: ['Approved', 'ok'], rejected: ['Declined', ''], expired: ['Expired', ''] }[status];
  return <span className={`chip ${tone}`}>{label}</span>;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: IconName }) {
  return (
    <div className="empty">
      {icon ? <div className="glyph"><Icon name={icon} /></div> : <Me size={64} state="idle" />}
      <h3>{title}</h3>
      {children && <p className="t3" style={{ maxWidth: '40ch' }}>{children}</p>}
    </div>
  );
}

export function Skeleton({ h = 64, n = 3 }: { h?: number; n?: number }) {
  return <div className="col">{Array.from({ length: n }, (_, i) => <div key={i} className="skeleton" style={{ height: h }} />)}</div>;
}

export function ErrorNote({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div className="panel pad between">
      <span className="t2">Couldn’t load this. {error.message}</span>
      <button className="btn sm" onClick={retry}>Try again</button>
    </div>
  );
}

export function Bar({ value }: { value: number }) {
  return (
    <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <span style={{ width: `${Math.max(3, value * 100)}%` }} />
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {children}
    </div>
  );
}

// ---- Toasts -------------------------------------------------------------

const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<{ text: string; key: number } | null>(null);
  const timer = useRef(0);
  const show = useCallback((text: string) => {
    window.clearTimeout(timer.current);
    setMsg({ text, key: Date.now() });
    timer.current = window.setTimeout(() => setMsg(null), 3200);
  }, []);
  // Any request that fails without its own handling still tells the person why.
  useEffect(() => {
    const onReject = (e: PromiseRejectionEvent) => {
      const err = e.reason as { message?: string; status?: number } | undefined;
      if (err?.message && err.status !== 401) show(err.message);
    };
    window.addEventListener('unhandledrejection', onReject);
    return () => window.removeEventListener('unhandledrejection', onReject);
  }, [show]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div key={msg.key} className="toast" role="status">{msg.text}</div>}
    </ToastCtx.Provider>
  );
}
