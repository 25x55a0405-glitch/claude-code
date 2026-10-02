import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKey, type MouseEvent as ReactMouse } from 'react';
import { api, type BrowserInput, type BrowserSession, type BrowserState, type Recording, type StarView } from '../api';
import { useLiveEvents } from '../lib/hooks';
import { Icon } from './Icon';
import { TeachReview } from './Teach';
import { useToast } from './ui';

/** The page size the server's browser renders at. Clicks are sent in these units. */
const PAGE_W = 1280;
const PAGE_H = 800;
const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/** A Star's tab in the real browser, kept live from browser.frame. Null until it opens something. */
export function useBrowserTab(starId: string | undefined) {
  const [state, setState] = useState<BrowserState | null>(null);
  const [tab, setTab] = useState<BrowserSession | null>(null);

  useEffect(() => {
    setTab(null);
    if (!starId) return;
    let live = true;
    api.getBrowser().then((b) => { if (live) { setState(b); setTab(b.sessions.find((s) => s.starId === starId && s.frameId) ?? null); } }, () => {});
    return () => { live = false; };
  }, [starId]);
  useLiveEvents((e) => {
    if ((e.type === 'browser.frame' || e.type === 'browser.control') && e.data.starId === starId) {
      const next = e.data;
      setTab((cur) => (next.frameId ? next : cur && e.type === 'browser.control' ? { ...cur, ...next, frameId: cur.frameId } : null));
    }
  });
  return { state, tab, setTab };
}

/** Short host for a URL, for "on kayak.com". */
export function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** A small live thumbnail of what the Star is looking at. Opens the full view. */
export function BrowserPip({ star, tab, onOpen }: { star: StarView; tab: BrowserSession; onOpen: () => void }) {
  const co = tab.checkout;
  const needs = (tab.control === 'person' && !!tab.waitingTaskId) || !!co;
  const yours = tab.control === 'person';
  return (
    <button className={`browser-pip ${needs ? 'needs' : ''}`} onClick={onOpen} aria-label={needs ? `${star.name} needs you in the browser` : `Watch ${star.name}’s browser`}>
      <span className="thumb"><img src={api.browserFrameUrl(star.id, tab.frameId)} alt="" /></span>
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="k">
          {co ? <><span className="live-dot attn" />{co.stage === 'paying' ? `Your turn to pay ${co.total}` : `${star.name} is ready to pay ${co.total}`}</> : tab.recordingId ? <><span className="rec-dot" />Recording what you do</> : needs ? <><span className="live-dot attn" />{star.name} needs you</> : yours ? <><span className="live-dot" />You have {star.name}’s browser</> : <><span className="live-dot" />{star.name} is browsing</>}
        </span>
        <span className="v">{co ? `at ${co.merchant}` : needs && tab.controlNote ? tab.controlNote : tab.title || hostOf(tab.url)}</span>
      </span>
      <span className="go">{co ? (co.stage === 'paying' ? 'Pay' : 'Review') : needs ? 'Help' : yours ? 'Open' : 'Watch'}</span>
    </button>
  );
}

/**
 * The full live view of a Star's tab. The server decides who drives it: taking
 * over (or just using the view) gives it to you, and while you have it any task
 * that needs the browser waits. Handing back lets the Star carry on, with your
 * note. If you go quiet for 2 minutes after only clicking, it goes back by itself.
 */
export function BrowserWindow({ star, tab, onClose, onTab }: { star: StarView; tab: BrowserSession; onClose: () => void; onTab: (t: BrowserSession | null) => void }) {
  const toast = useToast();
  const control = tab.control === 'person';
  const waiting = control && !!tab.waitingTaskId;
  const [url, setUrl] = useState(tab.url);
  const [editingUrl, setEditingUrl] = useState(false);
  const [rings, setRings] = useState<{ id: number; x: number; y: number }[]>([]);
  const [note, setNote] = useState('');
  const [autoBack, setAutoBack] = useState(false);
  const [teach, setTeach] = useState<{ title: string } | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [review, setReview] = useState<Recording | null>(null);
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const buffer = useRef('');
  const flushTimer = useRef(0);
  const ringId = useRef(0);
  const handingBack = useRef(false);
  const wasPerson = useRef(control);
  const recId = useRef<string | null>(tab.recordingId ?? null);
  if (tab.recordingId) recId.current = tab.recordingId;

  useEffect(() => { if (!editingUrl) setUrl(tab.url); }, [tab.url, editingUrl]);

  // Control went back to the Star without us asking: the 2 quiet minutes ran out.
  useEffect(() => {
    if (wasPerson.current && !control && !handingBack.current) setAutoBack(true);
    if (control) setAutoBack(false);
    wasPerson.current = control;
    handingBack.current = false;
  }, [control]);

  // Keep the recording live: its steps, and the draft once it ends (handing back ends it too).
  useEffect(() => {
    if (!tab.recordingId) return;
    let live = true;
    api.getRecording(tab.recordingId).then((r) => { if (live) setRecording(r); }, () => {});
    return () => { live = false; };
  }, [tab.recordingId]);
  useLiveEvents((e) => {
    if (e.type !== 'recording.updated' || e.data.starId !== star.id) return;
    if (e.data.status === 'recording') { recId.current = e.data.id; setRecording(e.data); }
    else if (e.data.id === recId.current && !e.data.skillId) { recId.current = null; setRecording(null); setReview(e.data); }
  });

  const send = useCallback(async (input: BrowserInput) => {
    try { onTab(await api.browserInput(star.id, input)); } catch (e) { toast((e as Error).message); }
  }, [star.id, onTab, toast]);

  const flush = useCallback(() => {
    window.clearTimeout(flushTimer.current);
    const text = buffer.current;
    buffer.current = '';
    if (text) return send({ type: 'type', text });
  }, [send]);

  const takeOver = async () => {
    try {
      onTab(await api.takeOverBrowser(star.id));
      window.setTimeout(() => frame.current?.focus(), 0);
    } catch (e) { toast((e as Error).message); }
  };
  const handBack = useCallback(async () => {
    await flush();
    handingBack.current = true;
    try {
      onTab(await api.handBackBrowser(star.id, note.trim() || undefined));
      setNote('');
      toast(waiting ? `${star.name} is carrying on` : `${star.name} has the browser again`);
    } catch (e) { handingBack.current = false; toast((e as Error).message); }
  }, [flush, note, onTab, star.id, star.name, toast, waiting]);

  const startTeach = async () => {
    if (!teach) return;
    setBusy(true);
    try {
      const r = await api.startRecording(star.id, { title: teach.title.trim() || undefined });
      setRecording(r);
      setTeach(null);
      window.setTimeout(() => frame.current?.focus(), 0);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const stopTeach = async () => {
    await flush();
    setBusy(true);
    handingBack.current = true;
    try {
      const r = await api.stopRecording(star.id);
      recId.current = null;
      setRecording(null);
      setReview(r);
    } catch (e) { handingBack.current = false; toast((e as Error).message); } finally { setBusy(false); }
  };

  // Closing the window leaves control where it is, so a quick look doesn't hand back mid-sign-in.
  const close = useCallback(() => { flush(); onClose(); }, [flush, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && document.activeElement !== frame.current) { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const click = (e: ReactMouse<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    const id = ++ringId.current;
    setRings((all) => [...all, { id, x: fx * 100, y: fy * 100 }]);
    window.setTimeout(() => setRings((all) => all.filter((x) => x.id !== id)), 700);
    frame.current?.focus();
    flush();
    send({ type: 'click', x: Math.round(fx * PAGE_W), y: Math.round(fy * PAGE_H) });
  };
  const key = (e: ReactKey<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length === 1) {
      e.preventDefault();
      buffer.current += e.key;
      window.clearTimeout(flushTimer.current);
      flushTimer.current = window.setTimeout(flush, 180);
    } else if (KEYS.has(e.key)) {
      e.preventDefault();
      if (e.key === 'Escape') { frame.current?.blur(); return; }
      Promise.resolve(flush()).then(() => send({ type: 'key', key: e.key }));
    }
  };

  if (review) return <TeachReview recording={review} star={star} onClose={onClose} />;

  const rec = recording ?? (tab.recordingId ? { steps: [] as Recording['steps'] } : null);

  return (
    <div className="modal-scrim browser-scrim" onClick={close}>
      <div className={`browser-window ${control ? 'yours' : ''} ${rec ? 'recording' : ''}`} role="dialog" aria-modal="true" aria-label={`${star.name}’s browser`} onClick={(e) => e.stopPropagation()}>
        <div className="browser-bar">
          <button className="icon-btn" aria-label="Back" onClick={() => send({ type: 'back' })}><Icon name="back" size={16} /></button>
          <form className="url" onSubmit={(e) => { e.preventDefault(); setEditingUrl(false); const u = url.trim(); if (u) send({ type: 'navigate', url: /^[a-z]+:\/\//i.test(u) ? u : `https://${u}` }); }}>
            <Icon name="lock" size={13} />
            <input value={url} onChange={(e) => setUrl(e.target.value)} onFocus={() => setEditingUrl(true)} onBlur={() => setEditingUrl(false)} aria-label="Address" spellCheck={false} />
          </form>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>

        {tab.checkout && <CheckoutBanner star={star} checkout={tab.checkout} />}

        {waiting && !rec && !tab.checkout && (
          <div className="browser-ask" role="status">
            <span className="glyph"><Icon name="cursor" size={15} /></span>
            <div className="grow" style={{ minWidth: 0 }}>
              <strong>{star.name} needs you</strong>
              <p>{tab.controlNote || 'It asked for a hand with this page.'}</p>
            </div>
          </div>
        )}

        <div
          ref={frame}
          className="browser-frame"
          tabIndex={0}
          onKeyDown={key}
          onPaste={(e) => { e.preventDefault(); buffer.current += e.clipboardData.getData('text'); flush(); }}
          onWheel={(e) => send({ type: 'scroll', dy: Math.round(e.deltaY) })}
          aria-label="The page. Click, type and scroll here"
        >
          <img src={api.browserFrameUrl(star.id, tab.frameId)} alt={`What ${star.name} sees: ${tab.title || hostOf(tab.url)}`} onClick={click} draggable={false} />
          {rings.map((r) => <span key={r.id} className="ring" style={{ left: `${r.x}%`, top: `${r.y}%` }} />)}
          {rec ? <span className="watching rec"><span className="rec-dot" />Recording · {rec.steps.length} step{rec.steps.length === 1 ? '' : 's'}</span>
            : !control && <span className="watching"><span className="live-dot" />Live</span>}
        </div>

        <div className="browser-foot">
          {rec ? (
            <>
              <p className="grow t2" style={{ fontSize: 14 }}>Do the job once, the way you’d want {star.name} to. It notes what you click and type. Passwords are never kept.</p>
              <button className="btn ink" onClick={stopTeach} disabled={busy}><Icon name="stop" size={14} /> {busy ? 'Drafting…' : 'Stop and review'}</button>
            </>
          ) : teach ? (
            <form className="row grow wrap" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); startTeach(); }}>
              <input className="field grow" style={{ minWidth: 200 }} value={teach.title} onChange={(e) => setTeach({ title: e.target.value })} placeholder="What’s the job? Like “Check my TAP miles”" aria-label="What you’ll teach" autoFocus />
              <button type="button" className="btn quiet" onClick={() => setTeach(null)}>Cancel</button>
              <button className="btn ink" disabled={busy}><Icon name="record" size={15} /> Start recording</button>
            </form>
          ) : control && tab.checkout?.stage === 'paying' ? (
            <>
              <p className="grow t2" style={{ fontSize: 14 }}>When you’ve paid, hand back and {star.name} checks the page for the confirmation. It won’t assume it went through.</p>
              <button className="btn ink" onClick={handBack}>I’ve paid, hand back</button>
            </>
          ) : control ? (
            <>
              <div className="grow col" style={{ gap: 8 }}>
                <p className="t2" style={{ fontSize: 14 }}>{waiting ? `When you’re done, hand back and ${star.name} carries on from here.` : `You have the browser. ${star.name} waits for you before it touches this tab.`}</p>
                <input className="field" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handBack(); } }} placeholder={waiting ? 'Tell it what you did, like “Signed in, code was by text”' : `A note for ${star.name} (optional)`} aria-label={`Note for ${star.name}`} maxLength={300} />
              </div>
              <button className="btn ink" onClick={handBack}>Hand back to {star.name}</button>
            </>
          ) : (
            <>
              <p className="grow t3">{autoBack ? `${star.name} has it back after 2 quiet minutes. Take over again any time.` : `Need to sign in or fix something? Take over and ${star.name} waits until you hand back. It still asks you before sending or buying anything.`}</p>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn quiet" onClick={() => setTeach({ title: '' })}><Icon name="record" size={15} /> Teach</button>
                <button className="btn" onClick={takeOver}><Icon name="cursor" size={15} /> Take over</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A Star stopped at payment: the total, then "You pay" once you say yes. */
function CheckoutBanner({ star, checkout }: { star: StarView; checkout: NonNullable<BrowserSession['checkout']> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const ok = async () => {
    setBusy(true);
    try {
      const a = (await api.listApprovals('pending')).find((x) => x.taskId === checkout.taskId && /^Pay /.test(x.action));
      if (!a) { toast('That payment isn’t waiting any more'); return; }
      await api.decideApproval(a.id, { decision: 'approve' });
      toast('Your turn: pay, then press Hand back');
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const paying = checkout.stage === 'paying';
  return (
    <div className={`checkout ${paying ? 'paying' : ''}`} role="status">
      <div className="checkout-sum">
        <span className="glyph"><Icon name="card" size={17} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 8, alignItems: 'baseline' }}>
            <strong className="checkout-total">{checkout.total}</strong>
            <span className="t2">at {checkout.merchant}</span>
          </div>
          {checkout.summary && <p className="t3 xs">{checkout.summary}</p>}
        </div>
        {!paying && <button className="btn ink sm" onClick={ok} disabled={busy}>{busy ? 'One moment…' : 'OK, I’ll pay'}</button>}
      </div>
      {paying ? (
        <ol className="you-pay">
          <li><span>1</span>Enter your card on the page. Only you do this.</li>
          <li><span>2</span>Finish paying.</li>
          <li><span>3</span>Press Hand back, and {star.name} carries on.</li>
        </ol>
      ) : (
        <p className="t3 xs">{star.name} filled in everything up to payment and is waiting for your OK. Saying yes gives you this browser so you can pay. It never enters card details.</p>
      )}
    </div>
  );
}
