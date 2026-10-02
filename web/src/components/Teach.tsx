import { useEffect, useState } from 'react';
import { api, type RecordedStep, type Recording, type StarView } from '../api';
import { useAgent } from '../lib/agent';
import { useLiveEvents } from '../lib/hooks';
import { navigate } from '../lib/router';
import { BrowserWindow, hostOf, useBrowserTab } from './BrowserView';
import { Icon, type IconName } from './Icon';
import { Skeleton, StarFace, Switch, useToast } from './ui';

const STEP_ICON: Record<RecordedStep['kind'], IconName> = { open: 'search', click: 'cursor', type: 'edit', key: 'chevron', scroll: 'menu', back: 'back' };

/** "Clicked “Log in”", for the list of what the person did. */
export function stepLine(s: RecordedStep) {
  if (s.kind === 'open') return `Opened ${hostOf(s.value ?? s.url)}`;
  if (s.kind === 'click') return `Clicked “${s.target ?? 'something'}”`;
  if (s.kind === 'type') return s.value === '[password]' ? `Typed a password into ${s.target ?? 'a field'} (not kept)` : `Typed “${s.value ?? ''}”${s.target ? ` into ${s.target}` : ''}`;
  if (s.kind === 'key') return `Pressed ${s.value ?? 'a key'}`;
  if (s.kind === 'back') return 'Went back';
  return 'Scrolled';
}

/**
 * After recording: the drafted skill to check and save. The draft is general
 * steps with placeholders; what you actually did is underneath for reference.
 */
export function TeachReview({ recording, star, onClose }: { recording: Recording; star: Pick<StarView, 'id' | 'name' | 'avatar'>; onClose: () => void }) {
  const toast = useToast();
  const [rec, setRec] = useState(recording);
  const [name, setName] = useState(recording.draft?.name ?? recording.title);
  const [whenToUse, setWhen] = useState(recording.draft?.whenToUse ?? '');
  const [steps, setSteps] = useState(recording.draft?.steps ?? '');
  const [touched, setTouched] = useState(false);
  const [shared, setShared] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [schedule, setSchedule] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drafting = rec.status === 'done' && !rec.draft && rec.steps.length > 0;

  // The draft can land a moment after recording ends (a model writes it): take it from
  // the live event, a newer copy passed in, or by asking again while it's still coming.
  const take = (r: Recording) => {
    setRec(r);
    if (r.draft && !touched) { setName(r.draft.name); setWhen(r.draft.whenToUse); setSteps(r.draft.steps); }
  };
  useLiveEvents((e) => { if (e.type === 'recording.updated' && e.data.id === rec.id) take(e.data); });
  useEffect(() => { if (recording.draft && !rec.draft) take(recording); }, [recording]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!drafting) return;
    let tries = 0;
    const t = window.setInterval(() => {
      if (++tries > 30) return window.clearInterval(t);
      api.getRecording(rec.id).then((r) => { if (r.draft || r.skillId) take(r); }, () => {});
    }, 1500);
    return () => window.clearInterval(t);
  }, [drafting, rec.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const edit = <T,>(set: (v: T) => void) => (v: T) => { setTouched(true); set(v); };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.saveRecordingAsSkill(rec.id, { name: name.trim(), whenToUse: whenToUse.trim(), steps: steps.trim(), shared, schedule: repeat && schedule.trim() ? schedule.trim() : undefined });
      toast(r.task ? `${r.skill.name} saved, and it runs ${schedule.trim().toLowerCase()}` : `${star.name} learned ${r.skill.name}`);
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const discard = async () => {
    try { await api.deleteRecording(rec.id); toast('Recording discarded'); onClose(); } catch (e) { setError((e as Error).message); }
  };

  const valid = name.trim() && whenToUse.trim() && steps.trim() && (!repeat || schedule.trim());

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form className="modal col-lg provider-form" role="dialog" aria-modal="true" aria-label="Review what you taught" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (valid) save(); }}>
        <div className="between">
          <div className="row" style={{ gap: 10 }}>
            <StarFace star={star} size={30} still />
            <h2>{rec.steps.length ? `What ${star.name} learned` : 'Nothing recorded'}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>

        {rec.steps.length === 0 ? (
          <p className="t2">The recording ended before you did anything. Open the browser and choose Teach to try again.</p>
        ) : drafting ? (
          <>
            <p className="t3">Turning {rec.steps.length} steps into a skill…</p>
            <Skeleton h={44} n={3} />
          </>
        ) : (
          <>
            <p className="t3" style={{ marginTop: -4 }}>Written from the {rec.steps.length} steps you showed. Make it general, so it works next time too.</p>
            <div>
              <label className="label" htmlFor="tr-name">Name</label>
              <input id="tr-name" className="field" value={name} maxLength={80} onChange={(e) => edit(setName)(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="tr-when">When to use it</label>
              <input id="tr-when" className="field" value={whenToUse} maxLength={300} onChange={(e) => edit(setWhen)(e.target.value)} placeholder="When I ask how many miles I have" />
            </div>
            <div>
              <label className="label" htmlFor="tr-steps">Steps</label>
              <textarea id="tr-steps" className="field steps" rows={7} value={steps} onChange={(e) => edit(setSteps)(e.target.value)} />
            </div>
          </>
        )}

        {rec.steps.length > 0 && (
          <div className="taught-raw">
            <button type="button" className="link-btn" onClick={() => setShowRaw((v) => !v)} aria-expanded={showRaw}>
              <Icon name="chevron" size={13} className={showRaw ? 'turn' : ''} /> What you did ({rec.steps.length})
            </button>
            {showRaw && (
              <ol className="rec-steps">
                {rec.steps.map((s, i) => (
                  <li key={i}><span className="glyph sm"><Icon name={STEP_ICON[s.kind]} size={13} /></span><span className="grow">{stepLine(s)}</span></li>
                ))}
              </ol>
            )}
          </div>
        )}

        {rec.steps.length > 0 && !drafting && (
          <div className="col" style={{ gap: 12 }}>
            <div className="between">
              <div>
                <h3 style={{ fontSize: 14.5 }}>Every Star can use it</h3>
                <p className="t3 xs">Otherwise only {star.name} does.</p>
              </div>
              <Switch label="Every Star can use it" checked={shared} onChange={setShared} />
            </div>
            <div className="between">
              <div>
                <h3 style={{ fontSize: 14.5 }}>Do it on a schedule too</h3>
                <p className="t3 xs">Sets up a goal for {star.name} that uses this skill.</p>
              </div>
              <Switch label="Do it on a schedule too" checked={repeat} onChange={setRepeat} />
            </div>
            {repeat && <input className="field" value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="Every Monday at 9:00" aria-label="How often" autoFocus />}
          </div>
        )}

        {error && <p className="send-error" role="alert" style={{ margin: 0 }}>{error}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn quiet danger" onClick={discard}><Icon name="trash" size={15} /> Discard</button>
          <span className="grow" />
          <button type="button" className="btn quiet" onClick={onClose}>Later</button>
          {rec.steps.length > 0 && <button type="submit" className="btn ink" disabled={!valid || busy || drafting}>{busy ? 'Saving…' : 'Save skill'}</button>}
        </div>
      </form>
    </div>
  );
}

/**
 * From Skills: pick a Star and a starting page, then the live browser opens in
 * recording mode. Do the job, stop, and review the draft.
 */
export function TeachStart({ onClose }: { onClose: () => void }) {
  const { stars } = useAgent();
  const toast = useToast();
  const [starId, setStarId] = useState(stars?.find((s) => s.id !== 'star_sky' && s.id)?.id ?? stars?.[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const star = stars?.find((s) => s.id === starId);
  const browser = useBrowserTab(started ? starId : undefined);

  useEffect(() => {
    if (started) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, started]);

  const start = async () => {
    setBusy(true);
    try {
      const u = url.trim();
      await api.startRecording(starId, { title: title.trim() || undefined, url: u ? (/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`) : undefined });
      setStarted(true);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };

  if (started && star) {
    return browser.tab
      ? <BrowserWindow star={star} tab={browser.tab} onTab={browser.setTab} onClose={() => { onClose(); navigate('skills'); }} />
      : <div className="modal-scrim"><div className="modal"><p className="t3">Opening {star.name}’s browser…</p><Skeleton h={180} /></div></div>;
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form className="modal col-lg" role="dialog" aria-modal="true" aria-label="Teach a task" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (starId) start(); }}>
        <div className="between">
          <h2>Teach a task</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <ol className="teach-how">
          <li><span>1</span>Start recording. The Star’s browser opens and you drive it.</li>
          <li><span>2</span>Do the job once, the way you like it done.</li>
          <li><span>3</span>Stop, check the steps it wrote, and save them as a skill.</li>
        </ol>
        {stars && stars.length > 1 && (
          <div>
            <span className="label">Who learns it</span>
            <div className="who-filter" role="group" aria-label="Who learns it">
              {stars.map((s) => <button type="button" key={s.id} aria-pressed={starId === s.id} onClick={() => setStarId(s.id)}><StarFace star={s} size={20} still />{s.name}</button>)}
            </div>
          </div>
        )}
        <div>
          <label className="label" htmlFor="teach-title">What’s the job</label>
          <input id="teach-title" className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Check my TAP miles" autoFocus />
        </div>
        <div>
          <label className="label" htmlFor="teach-url">Start on <span className="t3">(optional)</span></label>
          <input id="teach-url" className="field mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="flytap.com" spellCheck={false} />
        </div>
        <p className="t3 xs"><Icon name="lock" size={12} /> Passwords you type are never recorded. Recording stops by itself after 10 minutes.</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn ink" disabled={!starId || busy}><Icon name="record" size={15} /> {busy ? 'Opening…' : 'Start recording'}</button>
        </div>
      </form>
    </div>
  );
}
