import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKey, type MouseEvent as ReactMouse } from 'react';
import { api, type BrowserInput, type BrowserSession, type BrowserState, type StarView } from '../api';
import { useAgent } from '../lib/agent';
import { useLiveEvents } from '../lib/hooks';
import { Icon } from './Icon';
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
    if (e.type === 'browser.frame' && e.data.starId === starId) setTab(e.data.frameId ? e.data : null);
  });
  return { state, tab, setTab };
}

/** Short host for a URL, for "on kayak.com". */
export function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** A small live thumbnail of what the Star is looking at. Opens the full view. */
export function BrowserPip({ star, tab, onOpen }: { star: StarView; tab: BrowserSession; onOpen: () => void }) {
  return (
    <button className="browser-pip" onClick={onOpen} aria-label={`Watch ${star.name}’s browser`}>
      <span className="thumb"><img src={api.browserFrameUrl(star.id, tab.frameId)} alt="" /></span>
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="k"><span className="live-dot" />{star.name} is browsing</span>
        <span className="v">{tab.title || hostOf(tab.url)}</span>
      </span>
      <span className="go">Watch</span>
    </button>
  );
}

/**
 * The full live view of a Star's tab. Taking over pauses the Star so the two of
 * you aren't clicking at once; handing back wakes it, unless it was already paused.
 */
export function BrowserWindow({ star, tab, onClose, onTab }: { star: StarView; tab: BrowserSession; onClose: () => void; onTab: (t: BrowserSession | null) => void }) {
  const { upsertStar, status } = useAgent();
  const toast = useToast();
  const [control, setControl] = useState(false);
  const [pausedByUs, setPausedByUs] = useState(false);
  const [url, setUrl] = useState(tab.url);
  const [editingUrl, setEditingUrl] = useState(false);
  const [rings, setRings] = useState<{ id: number; x: number; y: number }[]>([]);
  const frame = useRef<HTMLDivElement>(null);
  const buffer = useRef('');
  const flushTimer = useRef(0);
  const ringId = useRef(0);

  useEffect(() => { if (!editingUrl) setUrl(tab.url); }, [tab.url, editingUrl]);

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
      if (!star.paused && status?.state !== 'paused') {
        upsertStar(await api.pauseStar(star.id, true));
        setPausedByUs(true);
      }
      setControl(true);
      window.setTimeout(() => frame.current?.focus(), 0);
    } catch (e) { toast((e as Error).message); }
  };
  const handBack = useCallback(async () => {
    await flush();
    setControl(false);
    if (pausedByUs) {
      setPausedByUs(false);
      try { upsertStar(await api.pauseStar(star.id, false)); } catch (e) { toast((e as Error).message); }
    }
    toast(`${star.name} has the browser again`);
  }, [flush, pausedByUs, star.id, star.name, toast, upsertStar]);

  const close = useCallback(() => { if (control) handBack(); onClose(); }, [control, handBack, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !control) { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [control, onClose]);

  const click = (e: ReactMouse<HTMLImageElement>) => {
    if (!control) return;
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
    if (!control || e.metaKey || e.ctrlKey || e.altKey) return;
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

  return (
    <div className="modal-scrim browser-scrim" onClick={close}>
      <div className={`browser-window ${control ? 'yours' : ''}`} role="dialog" aria-modal="true" aria-label={`${star.name}’s browser`} onClick={(e) => e.stopPropagation()}>
        <div className="browser-bar">
          <button className="icon-btn" aria-label="Back" disabled={!control} onClick={() => send({ type: 'back' })}><Icon name="back" size={16} /></button>
          <form className="url" onSubmit={(e) => { e.preventDefault(); setEditingUrl(false); const u = url.trim(); if (u) send({ type: 'navigate', url: /^[a-z]+:\/\//i.test(u) ? u : `https://${u}` }); }}>
            <Icon name="lock" size={13} />
            <input value={url} onChange={(e) => setUrl(e.target.value)} onFocus={() => setEditingUrl(true)} onBlur={() => setEditingUrl(false)} readOnly={!control} aria-label="Address" spellCheck={false} />
          </form>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>

        <div
          ref={frame}
          className="browser-frame"
          tabIndex={control ? 0 : -1}
          onKeyDown={key}
          onPaste={(e) => { if (!control) return; e.preventDefault(); buffer.current += e.clipboardData.getData('text'); flush(); }}
          onWheel={(e) => { if (control) send({ type: 'scroll', dy: Math.round(e.deltaY) }); }}
          aria-label={control ? 'The page. Click, type and scroll here' : undefined}
        >
          <img src={api.browserFrameUrl(star.id, tab.frameId)} alt={`What ${star.name} sees: ${tab.title || hostOf(tab.url)}`} onClick={click} draggable={false} />
          {rings.map((r) => <span key={r.id} className="ring" style={{ left: `${r.x}%`, top: `${r.y}%` }} />)}
          {!control && <span className="watching"><span className="live-dot" />Live</span>}
        </div>

        <div className="browser-foot">
          {control ? (
            <>
              <p className="grow t2" style={{ fontSize: 14 }}>You have the browser{pausedByUs ? `, and ${star.name} is paused` : ''}. Click, type or paste right on the page, then hand it back.</p>
              <button className="btn ink" onClick={handBack}>Hand back to {star.name}</button>
            </>
          ) : (
            <>
              <p className="grow t3">Need to sign in or fix something? Take over and {star.name} waits until you’re done. It still asks you before sending or buying anything.</p>
              <button className="btn" onClick={takeOver}><Icon name="cursor" size={15} /> Take over</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
