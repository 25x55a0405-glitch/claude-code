import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Message, type StarView, type VoiceStatus } from '../api';
import { useLiveEvents } from '../lib/hooks';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

type Mode = 'idle' | 'listening' | 'sending' | 'thinking' | 'speaking';

// The browser's own speech recognition, where it has one (Chrome, Edge, Safari).
type Rec = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; abort(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null };
const SpeechRec = (): (new () => Rec) | null => {
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
const canRecord = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
export const voiceSupported = () => canRecord() || !!SpeechRec();

/** Markdown and links read badly out loud. */
const speakable = (t: string) => t.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_#>]+/g, '').replace(/https?:\/\/\S+/g, 'the link').replace(/\s+/g, ' ').trim();

/** The browser's voice that best matches the Star's voice name, if any. */
function browserVoice(name?: string | null) {
  const all = window.speechSynthesis?.getVoices() ?? [];
  if (name) { const hit = all.find((v) => v.name.toLowerCase().includes(name.toLowerCase())); if (hit) return hit; }
  return all.find((v) => v.default && v.lang.startsWith(navigator.language.slice(0, 2))) ?? all.find((v) => v.lang.startsWith(navigator.language.slice(0, 2))) ?? null;
}

/** Plays one line in a Star's voice: the server's speech when set up, otherwise the browser's. */
export async function sayAs(text: string, star: Pick<StarView, 'id' | 'voice'>, server: boolean, audio?: { current: HTMLAudioElement | null }): Promise<void> {
  const line = speakable(text).slice(0, 4000);
  if (!line) return;
  if (server) {
    try {
      const blob = await api.speak(line, star.id || undefined);
      const url = URL.createObjectURL(blob);
      const el = new Audio(url);
      if (audio) audio.current = el;
      await new Promise<void>((resolve) => { el.onended = () => resolve(); el.onerror = () => resolve(); el.play().catch(() => resolve()); });
      URL.revokeObjectURL(url);
      return;
    } catch { /* fall through to the browser's speech */ }
  }
  if (!window.speechSynthesis) return;
  await new Promise<void>((resolve) => {
    const u = new SpeechSynthesisUtterance(line);
    const v = browserVoice(star.voice);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

/**
 * Talking to a Star out loud, with its character as the face. Tap to talk
 * (it stops by itself when you pause), or turn on Hands-free to keep going.
 * Uses the server's speech when it's set up, and the browser's own otherwise.
 */
export function VoiceMode({ star, conversationId, onUserMessage, onClose }: { star: StarView; conversationId: string; onUserMessage: (m: Message) => void; onClose: () => void }) {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [handsFree, setHandsFree] = useState(false);
  const [level, setLevel] = useState(0);
  const live = useRef(true);
  const modeRef = useRef<Mode>('idle');
  const waitingFor = useRef<{ since: number; id: string | null } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const rec = useRef<Rec | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const raf = useRef(0);
  const handsFreeRef = useRef(false);
  handsFreeRef.current = handsFree;
  const set = (m: Mode) => { modeRef.current = m; setMode(m); };

  useEffect(() => {
    api.getVoice().then((s) => { if (live.current) setStatus(s); }, () => { if (live.current) setStatus({ speechToText: [], textToSpeech: [], serverSpeechToText: false, serverTextToSpeech: false, settings: { sttProviderIds: [], sttModel: '', ttsProviderIds: [], ttsModel: '', ttsVoice: '' } }); });
    window.speechSynthesis?.getVoices();
    return () => { live.current = false; stopAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopAll = () => {
    cancelAnimationFrame(raf.current);
    try { recorder.current?.state === 'recording' && recorder.current.stop(); } catch { /* already stopped */ }
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    try { rec.current?.abort(); } catch { /* not running */ }
    audio.current?.pause();
    window.speechSynthesis?.cancel();
  };
  const close = useCallback(() => { stopAll(); onClose(); }, [onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const speakReply = async (text: string) => {
    if (!live.current) return;
    set('speaking');
    await sayAs(text, star, !!status?.serverTextToSpeech, audio);
    if (!live.current || modeRef.current !== 'speaking') return;
    set('idle');
    if (handsFreeRef.current) window.setTimeout(() => { if (live.current && modeRef.current === 'idle') listen(); }, 350);
  };

  // The Star's answer streams in like any chat reply.
  useLiveEvents((e) => {
    const w = waitingFor.current;
    if (!w) return;
    if (e.type === 'message.delta' && e.data.conversationId === conversationId) { w.id = e.data.messageId; setReply((r) => r + e.data.delta); }
    if (e.type === 'message.done' && e.data.conversationId === conversationId && e.data.role === 'agent' && (w.id === e.data.id || new Date(e.data.createdAt).getTime() >= w.since - 2000)) {
      waitingFor.current = null;
      setReply(e.data.content);
      speakReply(e.data.content);
    }
  });

  const gotUser = (m: Message, reply: Message | null) => {
    onUserMessage(m);
    setHeard(m.content);
    setReply('');
    if (reply && reply.status !== 'streaming') { setReply(reply.content); speakReply(reply.content); return; }
    waitingFor.current = { since: Date.now(), id: reply?.id ?? null };
    set('thinking');
  };

  const fail = (text: string) => { setNote(text); set('idle'); };

  const listenBrowser = () => {
    const R = SpeechRec();
    if (!R) return fail('This browser can’t listen. Try Chrome, Edge or Safari, or set up speech to text in Settings.');
    const r = new R();
    rec.current = r;
    r.lang = navigator.language || 'en-US';
    r.interimResults = true;
    r.continuous = false;
    let text = '';
    r.onresult = (e) => {
      text = Array.from(e.results).map((x) => x[0].transcript).join('');
      setHeard(text);
    };
    r.onerror = (e) => { if (e.error === 'not-allowed') fail('Sky needs your microphone. Allow it in the browser’s address bar, then try again.'); };
    r.onend = async () => {
      rec.current = null;
      if (!live.current || modeRef.current !== 'listening') return;
      const t = text.trim();
      if (!t) return fail('I didn’t catch that. Tap and try again.');
      set('sending');
      try { gotUser(await api.sendMessage(conversationId, t, 'voice'), null); } catch (err) { fail((err as Error).message); }
    };
    setHeard('');
    set('listening');
    r.start();
  };

  const listenServer = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = s;
      const type = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
      const mr = new MediaRecorder(s, type ? { mimeType: type } : undefined);
      recorder.current = mr;
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = async () => {
        cancelAnimationFrame(raf.current);
        s.getTracks().forEach((t) => t.stop());
        setLevel(0);
        if (!live.current || modeRef.current !== 'listening') return;
        const blob = new Blob(chunks, { type: (mr.mimeType || type || 'audio/webm').split(';')[0] });
        set('sending');
        try {
          const turn = await api.sendVoice(conversationId, blob);
          gotUser(turn.message, turn.reply);
        } catch (err) {
          const e = err as { status?: number; code?: string; message: string };
          if (e.status === 422) return fail('I didn’t catch that. Tap and try again.');
          if (e.status === 503) { setStatus((st) => st && { ...st, serverSpeechToText: false }); return fail('Speech to text isn’t set up on the server, so I’ll use the browser’s. Tap to try again.'); }
          fail(e.message);
        }
      };
      // Watch the level: it animates the face, and a pause after speaking ends the turn.
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(s).connect(an);
      const buf = new Uint8Array(an.fftSize);
      let spoke = false;
      let quietSince = 0;
      const started = Date.now();
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        const rms = Math.sqrt(sum / buf.length);
        setLevel(Math.min(1, rms * 6));
        const now = Date.now();
        if (rms > 0.04) { spoke = true; quietSince = 0; } else if (spoke && !quietSince) quietSince = now;
        if ((spoke && quietSince && now - quietSince > 1300) || now - started > 60_000 || (!spoke && now - started > 8000)) { ctx.close(); if (mr.state === 'recording') mr.stop(); return; }
        raf.current = requestAnimationFrame(tick);
      };
      mr.start();
      setHeard('');
      set('listening');
      raf.current = requestAnimationFrame(tick);
    } catch {
      fail('Sky needs your microphone. Allow it in the browser’s address bar, then try again.');
    }
  };

  const listen = () => {
    setNote(null);
    audio.current?.pause();
    window.speechSynthesis?.cancel();
    if (status?.serverSpeechToText && canRecord()) listenServer();
    else listenBrowser();
  };
  const stopListening = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    else rec.current?.stop();
  };
  const tap = () => {
    if (mode === 'listening') stopListening();
    else if (mode === 'speaking') { audio.current?.pause(); window.speechSynthesis?.cancel(); set('idle'); listen(); }
    else if (mode === 'idle') listen();
  };

  const label = { idle: handsFree ? 'Tap to start' : 'Tap to talk', listening: 'Listening…', sending: 'Sending…', thinking: `${star.name} is thinking…`, speaking: `${star.name} is speaking` }[mode];
  const browserOnly = status && !status.serverSpeechToText && !status.serverTextToSpeech;

  return (
    <div className="voice-mode" role="dialog" aria-modal="true" aria-label={`Talk to ${star.name}`}>
      <div className="voice-top">
        <span className="t3 xs"><strong className="voice-who">{star.name}</strong> · {status ? (browserOnly ? 'Using your browser’s speech' : `Speech by ${[status.speechToText[0]?.name, status.textToSpeech[0]?.name].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' and ') || 'your browser'}`) : ' '}</span>
        <button className="icon-btn" onClick={close} aria-label="Close voice"><Icon name="x" /></button>
      </div>

      <div className="voice-stage">
        <button className="voice-face" data-mode={mode} style={{ ['--level' as string]: level }} onClick={tap} aria-label={label} disabled={!status || mode === 'sending' || mode === 'thinking'}>
          <span className="halo" />
          <Avatar size={168} state={mode === 'thinking' || mode === 'sending' ? 'working' : 'idle'} character={star.avatar.character} color={star.avatar.color} label={star.name} />
        </button>
        <p className="voice-state" aria-live="polite">{note ?? label}</p>
        <div className="voice-lines">
          {heard && <p className="you">{heard}</p>}
          {reply && <p className="them">{reply}</p>}
        </div>
      </div>

      <div className="voice-bar">
        <label className="voice-hands">
          <input type="checkbox" checked={handsFree} onChange={(e) => setHandsFree(e.target.checked)} />
          <span>Hands-free</span>
        </label>
        <button className={`voice-mic ${mode === 'listening' ? 'on' : ''}`} onClick={tap} disabled={!status || mode === 'sending' || mode === 'thinking'} aria-label={mode === 'listening' ? 'Stop' : 'Talk'}>
          <Icon name={mode === 'listening' ? 'stop' : 'mic'} size={26} />
        </button>
        <span className="voice-hint t3 xs">{handsFree ? 'Listens again after each answer' : 'Stops when you pause'}</span>
      </div>
    </div>
  );
}
