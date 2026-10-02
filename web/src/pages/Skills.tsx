import { useEffect, useState } from 'react';
import { api, type Skill, type SkillSource } from '../api';
import { Icon } from '../components/Icon';
import { Empty, ErrorNote, PageHead, Skeleton, StarFace, useToast } from '../components/ui';
import { useAgent } from '../lib/agent';
import { relTime } from '../lib/format';
import { useLiveEvents, useResource } from '../lib/hooks';

/** Saved recipes the Stars follow, written by you or worked out by a Star. */
export function Skills() {
  const { stars } = useAgent();
  const list = useResource(() => api.listSkills(), []);
  const [who, setWho] = useState<string>('all');
  const [open, setOpen] = useState<Skill | 'new' | null>(null);

  useLiveEvents((e) => {
    if (e.type === 'skill.updated') list.setData((d) => d && (d.some((k) => k.id === e.data.id) ? d.map((k) => (k.id === e.data.id ? e.data : k)) : [e.data, ...d]));
    if (e.type === 'skill.deleted') list.setData((d) => d && d.filter((k) => k.id !== e.data.id));
  });

  const many = (stars?.length ?? 0) > 1;
  const shown = (list.data ?? []).filter((k) => who === 'all' || (who === 'shared' ? k.starId === null : k.starId === who));
  const starOf = (id: string | null) => (id ? stars?.find((s) => s.id === id) : null);
  const source = (k: Skill) => sourceLabel(k.source, starOf(k.starId)?.name);

  return (
    <div className="page">
      <PageHead title="Skills" sub="Step-by-step recipes your Stars follow when a job comes up again. They save new ones when they work out something worth repeating, and sharpen them when you correct them.">
        <button className="btn ink" onClick={() => setOpen('new')}><Icon name="plus" size={16} /> New skill</button>
      </PageHead>

      {many && (
        <div className="who-filter" role="group" aria-label="Whose skills">
          <button aria-pressed={who === 'all'} onClick={() => setWho('all')}>All</button>
          <button aria-pressed={who === 'shared'} onClick={() => setWho('shared')}>Every Star</button>
          {stars!.map((s) => (
            <button key={s.id} aria-pressed={who === s.id} onClick={() => setWho(s.id)}><StarFace star={s} size={20} still />{s.name}</button>
          ))}
        </div>
      )}

      {list.error ? <ErrorNote error={list.error} retry={list.reload} /> : !list.data ? <Skeleton h={88} n={3} /> : shown.length === 0 ? (
        <Empty title={list.data.length ? 'None here' : 'No skills yet'} icon="note">Write down how you like something done, like “Draft a reply in my voice”, and every Star that needs it follows the same steps.</Empty>
      ) : (
        <div className="skill-grid">
          {shown.map((k) => {
            const s = starOf(k.starId);
            return (
              <button key={k.id} className="panel skill-card" onClick={() => setOpen(k)}>
                <div className="between" style={{ alignItems: 'flex-start', gap: 10 }}>
                  <h3>{k.name}</h3>
                  {s ? <StarFace star={s} size={22} still /> : many ? <span className="chip">Every Star</span> : null}
                </div>
                <p className="t2" style={{ fontSize: 14 }}>{k.whenToUse}</p>
                <p className="t3 xs">{source(k)} · {k.uses ? `used ${k.uses} time${k.uses === 1 ? '' : 's'}${k.lastUsedAt ? `, last ${relTime(k.lastUsedAt)}` : ''}` : 'not used yet'}</p>
              </button>
            );
          })}
        </div>
      )}

      {open && <SkillEditor skill={open === 'new' ? null : open} defaultStar={who !== 'all' && who !== 'shared' ? who : null} onClose={() => setOpen(null)} />}
    </div>
  );
}

function sourceLabel(src: SkillSource, starName?: string) {
  if (src === 'builtIn') return 'Built in';
  if (src === 'star') return `Worked out by ${starName ?? 'a Star'}`;
  return 'Written by you';
}

function SkillEditor({ skill, defaultStar, onClose }: { skill: Skill | null; defaultStar: string | null; onClose: () => void }) {
  const { stars } = useAgent();
  const toast = useToast();
  const [name, setName] = useState(skill?.name ?? '');
  const [whenToUse, setWhen] = useState(skill?.whenToUse ?? '');
  const [steps, setSteps] = useState(skill?.steps ?? '');
  const [starId, setStarId] = useState<string | null>(skill ? skill.starId : defaultStar);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const builtIn = skill?.source === 'builtIn';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), whenToUse: whenToUse.trim(), steps: steps.trim(), starId };
    try {
      if (skill) await api.updateSkill(skill.id, body);
      else await api.createSkill(body);
      toast(skill ? 'Saved' : `${body.name} saved`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try { await api.deleteSkill(skill!.id); toast(`${skill!.name} removed`); onClose(); } catch (e) { setError((e as Error).message); }
  };

  const valid = name.trim() && whenToUse.trim() && steps.trim();
  // Each "- Lesson:" line is something a Star added after a correction.
  const lessons = steps.split('\n').filter((l) => l.startsWith('- Lesson:'));

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form className="modal col-lg provider-form" role="dialog" aria-modal="true" aria-label={skill ? skill.name : 'New skill'} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (valid && !builtIn) save(); }}>
        <div className="between">
          <h2>{skill ? (builtIn ? skill.name : 'Edit skill') : 'New skill'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        {builtIn ? (
          <>
            <p className="t2" style={{ fontSize: 14 }}>{skill!.whenToUse}</p>
            <pre className="steps-view">{skill!.steps}</pre>
            <p className="t3 xs">Built into Sky, so it can’t be changed or removed.</p>
          </>
        ) : (
          <>
            <div>
              <label className="label" htmlFor="sk-name">Name</label>
              <input id="sk-name" className="field" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Draft a reply in my voice" autoFocus={!skill} />
            </div>
            <div>
              <label className="label" htmlFor="sk-when">When to use it</label>
              <input id="sk-when" className="field" value={whenToUse} maxLength={200} onChange={(e) => setWhen(e.target.value)} placeholder="Writing any email reply for me" />
            </div>
            <div>
              <label className="label" htmlFor="sk-steps">Steps</label>
              <textarea id="sk-steps" className="field steps" rows={7} value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={'1. Read the whole thread.\n2. Answer the question in the first line.\n3. Keep it under five lines.'} />
              {lessons.length > 0 && <p className="t3 xs" style={{ marginTop: 6 }}>Lines starting “- Lesson:” were added by a Star after you corrected it. Edit or delete them like any other line.</p>}
            </div>
            {stars && stars.length > 1 && (
              <div>
                <span className="label">Who uses it</span>
                <div className="who-filter" role="group" aria-label="Who uses it">
                  <button type="button" aria-pressed={starId === null} onClick={() => setStarId(null)}>Every Star</button>
                  {stars.map((s) => (
                    <button type="button" key={s.id} aria-pressed={starId === s.id} onClick={() => setStarId(s.id)}><StarFace star={s} size={20} still />Only {s.name}</button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {skill && <p className="t3 xs">{sourceLabel(skill.source, stars?.find((s) => s.id === skill.starId)?.name)} · updated {relTime(skill.updatedAt)}</p>}
        {error && <p className="send-error" role="alert" style={{ margin: 0 }}>{error}</p>}
        {!builtIn && (
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {skill && (confirm ? (
              <><button type="button" className="btn danger" onClick={remove}>Remove for good</button><button type="button" className="btn quiet" onClick={() => setConfirm(false)}>Keep</button><span className="grow" /></>
            ) : (
              <><button type="button" className="btn quiet danger" onClick={() => setConfirm(true)}><Icon name="trash" size={15} /> Remove</button><span className="grow" /></>
            ))}
            <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn ink" disabled={!valid || busy}>{busy ? 'Saving…' : skill ? 'Save' : 'Save skill'}</button>
          </div>
        )}
      </form>
    </div>
  );
}
