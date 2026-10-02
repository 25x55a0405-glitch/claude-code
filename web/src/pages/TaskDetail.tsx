import { useState } from 'react';
import { api, type StepKind, type TaskCommand, type TaskStep } from '../api';
import { Icon, type IconName } from '../components/Icon';
import { ApprovalCard } from '../components/ApprovalCard';
import { ErrorNote, Progress, Skeleton, TaskStatusPill, kindMeta, useToast } from '../components/ui';
import { clockTime, dayLabel, relTime } from '../lib/format';
import { useLiveEvents, useResource } from '../lib/hooks';
import { href } from '../lib/router';

const stepIcon: Record<StepKind, IconName> = {
  plan: 'note',
  thought: 'sparkle',
  action: 'bolt',
  tool: 'wrench',
  result: 'check',
  approval: 'approve',
  error: 'alert',
  note: 'dot',
};

export function TaskDetailPage({ id }: { id: string }) {
  const toast = useToast();
  const task = useResource(() => api.getTask(id), [id], ['task.updated']);
  const approvals = useResource(async () => (await api.listApprovals('pending')).filter((a) => a.taskId === id), [id], ['approval.created', 'approval.updated']);
  const connections = useResource(() => api.listConnections(), []);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());

  useLiveEvents((e) => {
    if (e.type === 'task.step' && e.data.taskId === id) {
      task.setData((t) => (t && !t.steps.some((s) => s.id === e.data.step.id) ? { ...t, steps: [...t.steps, e.data.step] } : t));
      setFresh((f) => new Set(f).add(e.data.step.id));
    }
  });

  const command = async (c: TaskCommand) => {
    await api.commandTask(id, c);
    toast({ pause: 'Paused', resume: 'Resumed', run_now: 'Running now', cancel: 'Cancelled' }[c]);
    task.reload();
  };

  if (task.error) return <div className="page"><ErrorNote error={task.error} retry={task.reload} /></div>;
  const t = task.data;
  if (!t) return <div className="page"><Skeleton h={80} n={4} /></div>;

  const steps = [...t.steps].reverse();
  const groups: [string, TaskStep[]][] = [];
  for (const s of steps) {
    const label = dayLabel(s.at);
    const last = groups[groups.length - 1];
    if (last && last[0] === label) last[1].push(s);
    else groups.push([label, [s]]);
  }
  const conn = (cid?: string) => connections.data?.find((c) => c.id === cid)?.name;
  const kind = kindMeta[t.kind];
  const finished = t.status === 'done' || t.status === 'failed';

  return (
    <div className="page">
      <a href={href('tasks')} className="row faint"><Icon name="back" size={14} /> Tasks</a>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <TaskStatusPill status={t.status} />
            <span className="pill"><Icon name={kind.icon} size={12} /> {t.schedule ?? kind.label}</span>
          </div>
          <h1>{t.title}</h1>
          <p className="sub">{t.description}</p>
        </div>
        {!finished && (
          <div className="row">
            {t.status === 'paused' ? (
              <button className="btn" onClick={() => command('resume')}><Icon name="play" size={16} /> Resume</button>
            ) : (
              <button className="btn" onClick={() => command('pause')}><Icon name="pause" size={16} /> Pause</button>
            )}
            {t.kind !== 'one_off' && <button className="btn" onClick={() => command('run_now')}><Icon name="bolt" size={16} /> Run now</button>}
            <button className="btn btn-ghost btn-danger" onClick={() => command('cancel')}>Stop</button>
          </div>
        )}
      </div>

      {t.status === 'blocked' && (
        <div className="card row-between" style={{ borderColor: 'color-mix(in srgb, var(--warn) 45%, var(--border))' }}>
          <div className="row"><Icon name="alert" /><span>{t.lastOutcome}</span></div>
          <a className="btn btn-sm" href={href('connections')}>Fix connection</a>
        </div>
      )}

      {approvals.data?.map((a) => <ApprovalCard key={a.id} approval={a} onDecided={approvals.reload} />)}

      <div className="grid-main">
        <section className="card">
          <div className="card-head"><h2>What Skys did</h2><span className="faint">{t.steps.length} steps</span></div>
          {groups.map(([label, items]) => (
            <div key={label}>
              <div className="day-label">{label}</div>
              <div className="timeline">
                {items.map((s) => (
                  <div key={s.id} className={`tl-item ${fresh.has(s.id) ? 'fresh' : ''}`} data-kind={s.kind}>
                    <div className="node"><Icon name={stepIcon[s.kind]} size={11} /></div>
                    <div>{s.summary}</div>
                    <div className="when">
                      {clockTime(s.at)}
                      {conn(s.connectionId) && ` · ${conn(s.connectionId)}`}
                      {s.detail && (
                        <>
                          {' · '}
                          <button
                            className="btn-ghost"
                            style={{ border: 'none', background: 'none', color: 'var(--sky)', cursor: 'pointer', padding: 0, fontSize: 12 }}
                            onClick={() => setOpen((o) => { const n = new Set(o); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; })}
                            aria-expanded={open.has(s.id)}
                          >
                            {open.has(s.id) ? 'Hide details' : 'Details'}
                          </button>
                        </>
                      )}
                    </div>
                    {s.detail && open.has(s.id) && <div className="tl-detail mono">{s.detail}</div>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>

        <aside className="stack">
          <div className="card tight stack">
            {t.progress !== undefined && (
              <div className="stack" style={{ gap: 6 }}>
                <div className="row-between"><span className="faint">Progress</span><span className="faint">{Math.round(t.progress * 100)}%</span></div>
                <Progress value={t.progress} />
              </div>
            )}
            <Meta label="Started" value={relTime(t.createdAt)} />
            {t.lastRunAt && <Meta label="Last run" value={relTime(t.lastRunAt)} />}
            {t.nextRunAt && !finished && <Meta label="Next run" value={relTime(t.nextRunAt)} />}
            <Meta label="Last update" value={relTime(t.updatedAt)} />
          </div>
          {t.connectionIds.length > 0 && (
            <div className="card tight stack">
              <span className="faint">Uses</span>
              <div className="row">{t.connectionIds.map((c) => <span key={c} className="pill"><Icon name="plug" size={12} /> {conn(c) ?? c}</span>)}</div>
            </div>
          )}
          <a className="card tight row" href={href('chat')}><Icon name="chat" size={16} /> Talk to Skys about this task</a>
        </aside>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="row-between"><span className="faint">{label}</span><span>{value}</span></div>;
}
