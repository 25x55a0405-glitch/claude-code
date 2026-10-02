import { useState } from 'react';
import { api, type TaskKind, type TaskStatus } from '../api';
import { Icon } from '../components/Icon';
import { Bar, Empty, ErrorNote, PageHead, Segmented, Skeleton, StarFace, StatusChip, kindMeta, useToast } from '../components/ui';
import { mainStar, useAgent } from '../lib/agent';
import { relTime } from '../lib/format';
import { useResource } from '../lib/hooks';
import { href, navigate } from '../lib/router';

type Tab = 'now' | 'upcoming' | 'done';
const TABS: Record<Tab, TaskStatus[]> = {
  now: ['active', 'waiting_approval', 'blocked'],
  upcoming: ['scheduled', 'paused'],
  done: ['done', 'failed'],
};

export function Goals() {
  const [tab, setTab] = useState<Tab>('now');
  const [creating, setCreating] = useState(false);
  const [who, setWho] = useState<string | null>(null);
  const { stars } = useAgent();
  const many = (stars?.length ?? 0) > 1;
  const tasks = useResource(() => api.listTasks({ status: TABS[tab], starId: who ?? undefined }), [tab, who], ['task.updated']);
  const starOf = (id?: string) => (id && stars?.find((s) => s.id === id)) || mainStar(stars);

  return (
    <div className="page">
      <PageHead title="Goals" sub="Everything your Stars have taken on for you. They keep going between conversations.">
        <button className="btn ink" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> New goal</button>
      </PageHead>
      <div className="row wrap" style={{ gap: 10 }}>
        <Segmented label="Show" value={tab} onChange={setTab} options={[{ value: 'now', label: 'Working on' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'done', label: 'Done' }]} />
        {many && (
          <div className="who-filter" role="group" aria-label="Whose goals">
            <button aria-pressed={who === null} onClick={() => setWho(null)}>Everyone</button>
            {stars!.map((s) => (
              <button key={s.id} aria-pressed={who === s.id} onClick={() => setWho(s.id)}><StarFace star={s} size={18} still />{s.name}</button>
            ))}
          </div>
        )}
      </div>
      {tasks.error ? (
        <ErrorNote error={tasks.error} retry={tasks.reload} />
      ) : !tasks.data ? (
        <Skeleton h={92} n={4} />
      ) : tasks.data.length === 0 ? (
        <Empty title={tab === 'done' ? 'Nothing finished yet' : 'Nothing here yet'}>Tell Sky what you want handled, in chat or with New goal.</Empty>
      ) : (
        <div className="panel">
          <div className="rows">
            {tasks.data.map((t) => {
              const kind = kindMeta[t.kind];
              return (
                <a key={t.id} className="r goal" href={href('goals', t.id)}>
                  <div className="between"><h3>{t.title}</h3><StatusChip status={t.status} /></div>
                  {t.lastOutcome && <span className="t2" style={{ fontSize: 14 }}>{t.lastOutcome}</span>}
                  {t.progress !== undefined && t.status !== 'done' && <Bar value={t.progress} />}
                  <div className="meta">
                    {many && starOf(t.starId) && <><StarFace star={starOf(t.starId)!} size={16} still /><span>{starOf(t.starId)!.name}{t.requestedBy ? `, for ${starOf(t.requestedBy.starId)?.name ?? 'another Star'}` : ''}</span><span>·</span></>}
                    <Icon name={kind.icon} size={13} />
                    <span>{t.schedule ?? kind.label}</span>
                    <span>·</span>
                    <span>{t.nextRunAt && t.status !== 'done' ? `Next ${relTime(t.nextRunAt)}` : `Updated ${relTime(t.updatedAt)}`}</span>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      )}
      {creating && <NewGoal onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewGoal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<TaskKind>('one_off');
  const [schedule, setSchedule] = useState('');
  const { stars } = useAgent();
  const [starId, setStarId] = useState<string | undefined>(undefined);
  const owner = (starId && stars?.find((s) => s.id === starId)) || mainStar(stars);

  const submit = async () => {
    const t = await api.createTask({ title: title.trim(), description, kind, schedule: kind === 'one_off' ? undefined : schedule || undefined, ...(starId ? { starId } : {}) });
    toast('Goal started');
    onClose();
    navigate('goals', t.id);
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form className="modal col-lg" role="dialog" aria-modal="true" aria-label="New goal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="between">
          <h2>New goal</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div>
          <label className="label" htmlFor="ng-title">What should {owner?.name ?? 'Sky'} take care of?</label>
          <input id="ng-title" className="field" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Find a birthday gift for Sam" />
        </div>
        <div>
          <label className="label" htmlFor="ng-desc">Anything it should know</label>
          <textarea id="ng-desc" className="field" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Around $80. Sam loves coffee and hiking." />
        </div>
        {stars && stars.length > 1 && (
          <div>
            <span className="label">Who takes it</span>
            <div className="who-filter" role="group" aria-label="Who takes it">
              {stars.map((s) => (
                <button key={s.id} type="button" aria-pressed={owner?.id === s.id} onClick={() => setStarId(s.main ? undefined : s.id)}><StarFace star={s} size={18} still />{s.name}</button>
              ))}
            </div>
          </div>
        )}
        <div>
          <span className="label">How often</span>
          <Segmented label="How often" value={kind} onChange={setKind} options={[{ value: 'one_off', label: 'Once' }, { value: 'recurring', label: 'On a schedule' }, { value: 'watch', label: 'Keep watching' }]} />
        </div>
        {kind !== 'one_off' && (
          <div>
            <label className="label" htmlFor="ng-sched">{kind === 'watch' ? 'Check how often' : 'When'}</label>
            <input id="ng-sched" className="field" value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder={kind === 'watch' ? 'Every 3 hours' : 'Weekdays at 9:00'} />
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn ink" disabled={!title.trim()}>Start</button>
        </div>
      </form>
    </div>
  );
}
