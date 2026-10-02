import { useEffect, useState } from 'react';
import { api, type ModelProvider, type VoiceSettings as VS, type VoiceStatus } from '../api';
import { useResource } from '../lib/hooks';
import { href } from '../lib/router';
import { Icon } from './Icon';
import { useToast } from './ui';
import { sayAs } from './Voice';

const GROQ = 'https://api.groq.com/openai/v1';

/** Speech in and out. Free by default with the browser's own; better through your model providers. */
export function VoiceSettings() {
  const toast = useToast();
  const voice = useResource(() => api.getVoice(), []);
  const providers = useResource(() => api.listProviders(), []);
  const [draft, setDraft] = useState<VS | null>(null);
  const [busy, setBusy] = useState(false);
  const [trying, setTrying] = useState(false);

  useEffect(() => { if (voice.data) setDraft(voice.data.settings); }, [voice.data]);
  if (voice.error || !voice.data || !draft) return null;

  const v: VoiceStatus = voice.data;
  // Speech goes to OpenAI-style /audio endpoints, on the same base URL and key.
  const usable = (providers.data ?? []).filter((p) => p.kind === 'openai');
  const hasGroq = usable.some((p) => p.baseUrl.replace(/\/$/, '') === GROQ);
  const dirty = JSON.stringify(draft) !== JSON.stringify(v.settings);
  const set = (patch: Partial<VS>) => setDraft((d) => d && { ...d, ...patch });
  const toggle = (key: 'sttProviderIds' | 'ttsProviderIds', id: string) => set({ [key]: draft[key].includes(id) ? draft[key].filter((x) => x !== id) : [...draft[key], id] });

  const save = async () => {
    setBusy(true);
    try { voice.setData(await api.setVoice(draft)); toast('Voice saved'); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const tryIt = async () => {
    setTrying(true);
    try { await sayAs('Hi, this is how I sound when we talk.', { id: '', voice: draft.ttsVoice || null }, v.serverTextToSpeech); } finally { setTrying(false); }
  };

  const line = (on: boolean, list: { name: string }[]) => (on ? list.map((p) => p.name).join(', then ') : 'your browser');

  return (
    <section>
      <div className="section-title">Voice</div>
      <div className="panel">
        <div className="rows">
          <div className="r">
            <span className="glyph"><Icon name="mic" size={16} /></span>
            <div className="grow">
              <h3>{!v.serverSpeechToText && !v.serverTextToSpeech ? 'Free, with your browser’s own speech' : 'Talking through your providers'}</h3>
              <p className="t3 xs">Listening: {line(v.serverSpeechToText, v.speechToText)} · Speaking: {line(v.serverTextToSpeech, v.textToSpeech)}. Tap the mic in any Star’s chat to talk.</p>
            </div>
            <button className="btn sm quiet" onClick={tryIt} disabled={trying}><Icon name="play" size={13} /> {trying ? 'Playing…' : 'Hear it'}</button>
          </div>

          {!hasGroq && draft.sttProviderIds.length === 0 && (
            <div className="r voice-tip">
              <span className="glyph"><Icon name="sparkle" size={16} /></span>
              <p className="grow t2" style={{ fontSize: 14 }}>For better listening at no cost, add Groq in <a href={href('models')} style={{ textDecoration: 'underline' }}>Models</a> (OpenAI-compatible, base URL <code className="mono">{GROQ}</code>) and pick it below with <code className="mono">whisper-large-v3-turbo</code>. Its free tier allows 2,000 requests a day.</p>
            </div>
          )}

          <Direction
            title="Listening (speech to text)"
            providers={usable}
            picked={draft.sttProviderIds}
            onToggle={(id) => toggle('sttProviderIds', id)}
            model={draft.sttModel}
            onModel={(m) => set({ sttModel: m })}
            modelHint="whisper-large-v3-turbo"
          />
          <Direction
            title="Speaking (text to speech)"
            providers={usable}
            picked={draft.ttsProviderIds}
            onToggle={(id) => toggle('ttsProviderIds', id)}
            model={draft.ttsModel}
            onModel={(m) => set({ ttsModel: m })}
            modelHint="tts-1, or kokoro on your own server"
            extra={(
              <div>
                <label className="label" htmlFor="tts-voice">Default voice</label>
                <input id="tts-voice" className="field" value={draft.ttsVoice} onChange={(e) => set({ ttsVoice: e.target.value })} placeholder="nova" list="voice-names" spellCheck={false} />
                <VoiceNames />
                <p className="t3 xs" style={{ marginTop: 6 }}>Each Star can have its own on its page.</p>
              </div>
            )}
          />
          {dirty && (
            <div className="r" style={{ justifyContent: 'flex-end' }}>
              <button className="btn quiet" onClick={() => setDraft(v.settings)}>Cancel</button>
              <button className="btn ink" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Direction({ title, providers, picked, onToggle, model, onModel, modelHint, extra }: { title: string; providers: ModelProvider[]; picked: string[]; onToggle: (id: string) => void; model: string; onModel: (m: string) => void; modelHint: string; extra?: React.ReactNode }) {
  const id = title.replace(/\W+/g, '-').toLowerCase();
  return (
    <div className="r col" style={{ alignItems: 'stretch', gap: 10 }}>
      <h3 style={{ fontSize: 14.5 }}>{title}</h3>
      {providers.length === 0 ? (
        <p className="t3 xs">No OpenAI-compatible providers yet, so your browser does this. Add one in <a href={href('models')} style={{ textDecoration: 'underline' }}>Models</a>.</p>
      ) : (
        <>
          <div className="row wrap" style={{ gap: 6 }}>
            {providers.map((p) => {
              const at = picked.indexOf(p.id);
              return (
                <button key={p.id} type="button" className={`idea-pill sm ${at >= 0 ? 'on' : ''}`} aria-pressed={at >= 0} onClick={() => onToggle(p.id)}>
                  {at >= 0 && <span className="order-n">{at + 1}</span>}{p.name}
                </button>
              );
            })}
          </div>
          <p className="t3 xs">{picked.length ? 'In this order. If one fails or is rate limited, the next one takes over, then your browser.' : 'None picked, so your browser does this.'}</p>
          {picked.length > 0 && (
            <div className="grid2">
              <div>
                <label className="label" htmlFor={`${id}-model`}>Model</label>
                <input id={`${id}-model`} className="field mono" value={model} onChange={(e) => onModel(e.target.value)} placeholder={modelHint} spellCheck={false} />
              </div>
              {extra}
            </div>
          )}
        </>
      )}
      {picked.length === 0 && extra}
    </div>
  );
}

/** Voice names to suggest: the usual OpenAI-style ones, and this browser's. */
export function VoiceNames() {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    const read = () => setNames((window.speechSynthesis?.getVoices() ?? []).map((v) => v.name));
    read();
    window.speechSynthesis?.addEventListener?.('voiceschanged', read);
    return () => window.speechSynthesis?.removeEventListener?.('voiceschanged', read);
  }, []);
  return (
    <datalist id="voice-names">
      {['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'af_heart', 'am_michael', ...names].map((n) => <option key={n} value={n} />)}
    </datalist>
  );
}
