import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { AgentState, Approval, ConnectionStatus, Risk, TaskKind, TaskStatus } from '../api';
import { Icon, type IconName } from './Icon';

export function Orb({ state, size }: { state: AgentState; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  return <div className={`orb ${size ?? ''}`} data-state={state} role="img" aria-label={`Skys is ${stateLabel[state].toLowerCase()}`} />;
}

export const stateLabel: Record<AgentState, string> = {
  idle: 'Idle',
  working: 'Working',
  waiting: 'Needs you',
  paused: 'Paused',
  offline: 'Offline',
};

const taskStatusPill: Record<TaskStatus, [string, string]> = {
  active: ['Working', 'sky'],
  scheduled: ['Scheduled', 'violet'],
  waiting_approval: ['Needs you', 'dawn'],
  blocked: ['Blocked', 'warn'],
  paused: ['Paused', ''],
  done: ['Done', 'ok'],
  failed: ['Failed', 'danger'],
};

export function TaskStatusPill({ status }: { status: TaskStatus }) {
  const [label, tone] = taskStatusPill[status];
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

export const kindMeta: Record<TaskKind, { label: string; icon: IconName }> = {
  one_off: { label: 'One-off', icon: 'flag' },
  recurring: { label: 'Recurring', icon: 'repeat' },
  watch: { label: 'Watching', icon: 'eye' },
};

export function RiskPill({ risk }: { risk: Risk }) {
  const tone = { low: 'ok', medium: 'dawn', high: 'danger' }[risk];
  return <span className={`pill ${tone}`}>{risk[0].toUpperCase() + risk.slice(1)} risk</span>;
}

export function ConnectionPill({ status }: { status: ConnectionStatus }) {
  const [label, tone] = { connected: ['Connected', 'ok'], expired: ['Reconnect', 'warn'], disconnected: ['Not connected', ''] }[status];
  return <span className={`pill ${tone}`}><span className="dot" />{label}</span>;
}

export function ApprovalStatusPill({ status }: { status: Approval['status'] }) {
  const [label, tone] = { pending: ['Waiting', 'dawn'], approved: ['Approved', 'ok'], rejected: ['Declined', ''], expired: ['Expired', ''] }[status];
  return <span className={`pill ${tone}`}>{label}</span>;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      className="toggle"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon-tile"><Icon name={icon} /></div>
      <h3>{title}</h3>
      {children && <p className="faint">{children}</p>}
    </div>
  );
}

export function Skeleton({ h = 72, n = 3 }: { h?: number; n?: number }) {
  return (
    <div className="stack">
      {Array.from({ length: n }, (_, i) => <div key={i} className="skeleton" style={{ height: h }} />)}
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div className="card row-between">
      <div className="row"><Icon name="alert" /><span>Couldn’t load this: {error.message}</span></div>
      <button className="btn btn-sm" onClick={retry}>Try again</button>
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <span style={{ width: `${Math.max(3, value * 100)}%` }} />
    </div>
  );
}

// ---- Toasts -------------------------------------------------------------

const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg((cur) => (cur === m ? null : cur)), 2600);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </ToastCtx.Provider>
  );
}
