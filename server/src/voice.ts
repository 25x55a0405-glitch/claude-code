import type { ModelRegistry } from './models/registry.ts';
import { scrubKey } from './models/router.ts';
import type { Store } from './store.ts';
import type { ModelProvider, VoiceSettings, VoiceStatus } from './types.ts';
import { ApiError } from './util.ts';

/** Largest recording accepted for one turn (about 10 minutes of compressed speech). */
export const MAX_AUDIO = 25 * 1024 * 1024;
const TIMEOUT_MS = 45_000;
/** A speech provider that failed is skipped for this long. */
const COOLDOWN_MS = 2 * 60_000;
const SPEAK_LIMIT = 4_000;

export const defaultVoice = (): VoiceSettings => ({ sttProviderIds: [], sttModel: 'whisper-large-v3-turbo', ttsProviderIds: [], ttsModel: 'tts-1', ttsVoice: 'alloy' });

/**
 * Speech for talking with a Star. Both directions use OpenAI-compatible
 * audio endpoints on the person's own model providers (the same base URL
 * and key): /audio/transcriptions for speech to text (Groq's free Whisper,
 * a self-hosted faster-whisper or whisper.cpp server, OpenAI) and
 * /audio/speech for text to speech (a self-hosted Kokoro or openedai-speech,
 * OpenAI). Each direction has its own ordered list, tried in turn.
 *
 * With nothing set up, the endpoints answer 503 `voice_unavailable` and the
 * app uses the browser's own speech recognition and speech synthesis, which
 * are free and need no server.
 */
export class Voice {
  store: Store;
  registry: ModelRegistry;
  fetch: typeof fetch = (...args) => fetch(...args);
  private cooling = new Map<string, number>();

  constructor(store: Store, registry: ModelRegistry) {
    this.store = store;
    this.registry = registry;
  }

  settings(): VoiceSettings {
    return { ...defaultVoice(), ...(this.store.settings().voice ?? {}) };
  }

  status(): VoiceStatus {
    const v = this.settings();
    const names = (ids: string[]) => this.usable(ids).map((p) => ({ id: p.id, name: p.name }));
    const stt = names(v.sttProviderIds);
    const tts = names(v.ttsProviderIds);
    return { speechToText: stt, textToSpeech: tts, serverSpeechToText: stt.length > 0, serverTextToSpeech: tts.length > 0, settings: v };
  }

  private usable(ids: string[]): ModelProvider[] {
    return ids.map((id) => this.registry.list().find((p) => p.id === id)).filter((p): p is ModelProvider => Boolean(p && p.enabled && p.kind === 'openai'));
  }

  /** Speech to text: the first provider that answers. */
  async transcribe(audio: Buffer, type: string, language?: string): Promise<{ text: string; provider: string }> {
    if (!audio.length) throw new ApiError(400, 'bad_request', 'The recording is empty');
    const v = this.settings();
    const result = await this.walk(v.sttProviderIds, 'speech to text', async (p, signal) => {
      const form = new FormData();
      form.append('file', new Blob([audio], { type: type || 'audio/webm' }), `speech.${extension(type)}`);
      form.append('model', v.sttModel);
      form.append('response_format', 'json');
      if (language) form.append('language', language);
      const res = await this.call(p, '/audio/transcriptions', { method: 'POST', body: form, signal });
      const body = await res.json() as { text?: unknown };
      if (typeof body.text !== 'string') throw new Error('The answer had no text');
      return body.text.trim();
    });
    return { text: result.out, provider: result.provider };
  }

  /** Text to speech, in the Star's voice when it has one. */
  async speak(text: string, voice?: string | null): Promise<{ audio: Buffer; type: string; provider: string }> {
    const v = this.settings();
    const input = text.replace(/[*_`#>]+/g, '').slice(0, SPEAK_LIMIT);
    const result = await this.walk(v.ttsProviderIds, 'text to speech', async (p, signal) => {
      const res = await this.call(p, '/audio/speech', {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: v.ttsModel, input, voice: voice || v.ttsVoice, response_format: 'mp3' }),
      });
      return { audio: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type')?.split(';')[0] || 'audio/mpeg' };
    });
    return { ...result.out, provider: result.provider };
  }

  private async call(p: ModelProvider, path: string, init: RequestInit): Promise<Response> {
    const key = this.registry.apiKey(p.id);
    const res = await this.fetch(`${p.baseUrl.replace(/\/+$/, '')}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let message = body;
      try {
        const j = JSON.parse(body);
        message = j?.error?.message ?? j?.message ?? j?.detail ?? body;
      } catch { /* plain text */ }
      throw new Error(`${res.status} ${String(message).slice(0, 200) || res.statusText}`);
    }
    return res;
  }

  private async walk<T>(ids: string[], what: string, run: (p: ModelProvider, signal: AbortSignal) => Promise<T>): Promise<{ out: T; provider: string }> {
    const list = this.usable(ids);
    if (!list.length) throw new ApiError(503, 'voice_unavailable', `No ${what} provider is set up, so the app uses the browser’s own.`);
    const now = Date.now();
    const ready = list.filter((p) => (this.cooling.get(p.id) ?? 0) <= now);
    const errors: string[] = [];
    for (const p of ready.length ? ready : list) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const out = await run(p, ctrl.signal);
        this.cooling.delete(p.id);
        return { out, provider: p.name };
      } catch (err) {
        this.cooling.set(p.id, Date.now() + COOLDOWN_MS);
        const message = ctrl.signal.aborted ? `timed out after ${TIMEOUT_MS / 1000}s` : (err as Error).message;
        errors.push(`${p.name}: ${scrubKey(message, this.registry.apiKey(p.id))}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ApiError(502, 'voice_failed', `No ${what} provider answered. ${errors.join(' | ')}`);
  }
}

function extension(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('wav')) return 'wav';
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return 'm4a';
  if (t.includes('ogg')) return 'ogg';
  if (t.includes('flac')) return 'flac';
  return 'webm';
}
