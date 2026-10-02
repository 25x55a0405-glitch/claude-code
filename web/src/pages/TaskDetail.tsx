import { useState } from 'react';
import { api, type StepKind, type TaskCommand, type TaskStep } from '../api';
import { ApprovalCard } from '../components/ApprovalCard';
import { Icon, type IconName } from '../components/Icon';
import { Bar, ErrorNote, Skeleton, StatusChip, kindMeta, useToast } from '../components/ui';
import { clockTime, dayLabel, relTime } from '../lib/format';
import { useLiveEvents, useResource } from '../lib/hooks';
import { href } from '../lib/router';

const stepIcon: Record<StepKind, IconName> = {
  plan: 'note', thought: 'sparkle', action: 'bolt', tool: 'wrench', result: 'check', approval: 'approve', error: 'alert', note: 'dot',
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
    try {
      await api.commandTask(id, c);
      toast({ pause: 'Paused', resume: 'Resumed', run_now: 'Running now', cancel: 'Stopped' }[c]);
    } catch (e) {
      toast((e as Error).message);
    }
    task.reload();
  };

  if (task.error) return <div className="page"><ErrorNote error={task.error} retry={task.reload} /></div>;
  const t = task.data;
  if (!t) return <div className="page"><Skeleton h={72} n={4} /></div>;

  const groups: [string, TaskStep[]][] = [];
  for (const s of [...t.steps].reverse()) {
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
      <a href={href('goals')} className="row t3"><Icon name="back" size={14} /> Goals</a>
      <div className="col">
        <div className="row wrap">
          <StatusChip status={t.status} />
          <span className="chip"><Icon name={kind.icon} size={12} /> {t.schedule ?? kind.label}</span>
          {t.connectionIds.map((c) => <span key={c} className="chip">{conn(c) ?? c}</span>)}
        </div>
        <h1>{t.title}</h1>
        <p className="t2" style={{ maxWidth: '60ch' }}>{t.description}</p>
        {t.progress !== undefined && !finished && (
          <div className="col" style={{ gap: 6, maxWidth: 420 }}>
            <Bar value={t.progress} />
            <span className="t3 xs num">{Math.round(t.progress * 100)}% · started {relTime(t.createdAt)}{t.nextRunAt ? ` · next ${relTime(t.nextRunAt)}` : ''}</span>
          </div>
        )}
        {!finished && (
          <div className="row wrap" style={{ marginTop: 4 }}>
            {t.status === 'paused'
              ? <button className="btn sm" onClick={() => command('resume')}><Icon name="play" size={14} /> Resume</button>
              : <button className="btn sm" onClick={() => command('pause')}><Icon name="pause" size={14} /> Pause</button>}
            {t.kind !== 'one_off' && <button className="btn sm" onClick={() => command('run_now')}><Icon name="bolt" size={14} /> Run now</button>}
            <button className="btn quiet sm danger" onClick={() => command('cancel')}>Stop</button>
          </div>
        )}
      </div>

      {t.status === 'blocked' && (
        <div className="panel pad between" style={{ background: 'var(--warn-soft)', borderColor: 'transparent' }}>
          <span>{t.lastOutcome}</span>
          <a className="btn sm" href={href('permissions')}>Reconnect</a>
        </div>
      )}

      {approvals.data?.map((a) => <ApprovalCard key={a.id} approval={a} onDecided={() => approvals.reload()} />)}

      <section>
        <div className="section-title">What Skys did</div>
        <div className="panel pad col-lg">
          {groups.map(([label, items]) => (
            <div key={label} className="col">
              <span className="t3 xs">{label}</span>
              <div className="steps">
                {items.map((s) => (
                  <div key={s.id} className={`step ${fresh.has(s.id) ? 'fresh' : ''}`} data-kind={s.kind}>
                    <div className="pip"><Icon name={stepIcon[s.kind]} size={12} /></div>
                    <div style={{ minWidth: 0 }}>
                      <div>{s.summary}</div>
                      <div className="when">
                        {clockTime(s.at)}{conn(s.connectionId) && ` · ${conn(s.connectionId)}`}
                        {s.detail && (
                          <>{' · '}<button className="linkish" aria-expanded={open.has(s.id)} onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })}>{open.has(s.id) ? 'Hide details' : 'Details'}</button></>
                        )}
                      </div>
                      {s.detail && open.has(s.id) && <div className="detail mono">{s.detail}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
