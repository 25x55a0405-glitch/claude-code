import { useEffect, useState } from 'react';
import { api, type PushTestResult } from '../api';
import { useAgent } from '../lib/agent';
import { relTime } from '../lib/format';
import { useResource } from '../lib/hooks';
import { deviceLabel, isIos, pushState, randomTopic, subscribeHere, unsubscribeHere, type PushHere } from '../lib/push';
import { Icon } from './Icon';
import { Switch, useToast } from './ui';

const HERE_LINE: Record<PushHere, string> = {
  unsupported: 'This browser can’t get push notifications from Sky.',
  'needs-home-screen': 'Add Sky to your Home Screen first, then turn this on from there.',
  blocked: 'Notifications are blocked for this site. Allow them in the browser’s site settings.',
  off: 'Not getting notifications here yet.',
  on: 'This browser gets notifications.',
};

/** Push to this browser or phone, plus ntfy as a second free channel. */
export function PushSetup() {
  const { settings, setSettings } = useAgent();
  const toast = useToast();
  const subs = useResource(() => api.listPushSubscriptions(), []);
  const [here, setHere] = useState<PushHere | null>(null);
  const [busy, setBusy] = useState(false);
  const [topic, setTopic] = useState(settings?.ntfyTopic ?? '');
  const [server, setServer] = useState(settings?.ntfyServer ?? '');
  const [more, setMore] = useState(!!settings?.ntfyServer);
  const [test, setTest] = useState<PushTestResult | string | null>(null);

  useEffect(() => { pushState().then(setHere, () => setHere('unsupported')); }, []);
  useEffect(() => { setTopic(settings?.ntfyTopic ?? ''); setServer(settings?.ntfyServer ?? ''); }, [settings?.ntfyTopic, settings?.ntfyServer]);

  if (!settings) return null;
  const pushOn = settings.channels.push;
  const savedTopic = settings.ntfyTopic ?? '';
  const topicOk = /^[A-Za-z0-9_-]{1,64}$/.test(topic.trim());
  const ntfyBase = (settings.ntfyServer || 'https://ntfy.sh').replace(/\/$/, '');

  const save = async (patch: Parameters<typeof api.updateSettings>[0]) => {
    try { setSettings(await api.updateSettings(patch)); } catch (e) { toast((e as Error).message); throw e; }
  };

  const turnOnHere = async () => {
    setBusy(true);
    try {
      const { publicKey } = await api.getPushKey();
      const sub = await subscribeHere(publicKey);
      await api.addPushSubscription(sub, deviceLabel());
      if (!pushOn) await save({ channels: { ...settings.channels, push: true } });
      setHere('on');
      subs.reload();
      toast('Notifications are on here');
    } catch (e) {
      toast((e as Error).message);
      pushState().then(setHere, () => {});
    } finally {
      setBusy(false);
    }
  };
  const turnOffHere = async () => {
    setBusy(true);
    try { await unsubscribeHere(); setHere('off'); toast('Notifications are off here'); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const sendTest = async () => {
    setTest(null);
    try { setTest(await api.testPush()); subs.reload(); } catch (e) { setTest((e as Error).message); }
  };

  return (
    <section>
      <div className="section-title">Notifications on your devices</div>
      {isIos() && here === 'needs-home-screen' && <HomeScreenHint />}
      <div className="panel">
        <div className="rows">
          <div className="r">
            <div className="grow">
              <h3>Push notifications</h3>
              <p className="t3 xs">Stars ping your devices when they finish something or need you. Each Star can choose on its page.</p>
            </div>
            <Switch label="Push notifications" checked={pushOn} onChange={(v) => save({ channels: { ...settings.channels, push: v } }).catch(() => {})} />
          </div>
          <div className="r">
            <span className="glyph"><Icon name="bolt" size={16} /></span>
            <div className="grow">
              <h3>This browser</h3>
              <p className="t3 xs">{here ? HERE_LINE[here] : 'Checking…'}</p>
            </div>
            {here === 'off' && <button className="btn sm ink" onClick={turnOnHere} disabled={busy}>{busy ? 'Asking…' : 'Turn on here'}</button>}
            {here === 'on' && <button className="btn sm quiet" onClick={turnOffHere} disabled={busy}>Turn off here</button>}
          </div>
          {subs.data?.map((p) => (
            <div key={p.id} className="r">
              <span className="glyph"><Icon name="check" size={16} /></span>
              <div className="grow">
                <h3>{p.label}</h3>
                <p className="t3 xs">Added {relTime(p.createdAt)}{p.lastSentAt ? ` · last ping ${relTime(p.lastSentAt)}` : ''}</p>
              </div>
              <button className="icon-btn" aria-label={`Stop sending to ${p.label}`} onClick={async () => { try { await api.deletePushSubscription(p.id); subs.setData((d) => d && d.filter((x) => x.id !== p.id)); } catch (e) { toast((e as Error).message); } }}><Icon name="trash" size={16} /></button>
            </div>
          ))}
        </div>
      </div>

      <div className="panel pad col" style={{ marginTop: 12 }}>
        <div>
          <h3>ntfy</h3>
          <p className="t3" style={{ marginTop: 2 }}>A free app for Android and iPhone that works without an account. Install ntfy, subscribe to your topic, and pings arrive there too.</p>
        </div>
        <form className="row wrap" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (topicOk) save({ ntfyTopic: topic.trim(), ...(more ? { ntfyServer: server.trim() } : {}) }).then(() => toast('ntfy topic saved'), () => {}); }}>
          <input className="field mono grow" style={{ minWidth: 200 }} value={topic} onChange={(e) => setTopic(e.target.value.replace(/\s/g, '-'))} placeholder="sky-a-long-random-topic" aria-label="ntfy topic" spellCheck={false} />
          <button type="button" className="btn" onClick={() => setTopic(randomTopic())}>Make one</button>
          <button type="submit" className="btn ink" disabled={!topicOk || (topic.trim() === savedTopic && (!more || server.trim() === (settings.ntfyServer ?? '')))}>Save</button>
        </form>
        {topic && !topicOk && <p className="xs" style={{ color: 'var(--danger)' }}>Letters, digits, - and _ only, up to 64.</p>}
        <p className="t3 xs">Anyone who knows the topic can read it, so keep it long and random.</p>
        {more ? (
          <div>
            <label className="label" htmlFor="ntfy-server">Your own ntfy server <span className="t3">(optional)</span></label>
            <input id="ntfy-server" className="field mono" value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://ntfy.sh" spellCheck={false} />
          </div>
        ) : (
          <button type="button" className="link-btn t3 xs" onClick={() => setMore(true)}>Use your own ntfy server</button>
        )}
        {savedTopic && (
          <div className="row wrap" style={{ gap: 8 }}>
            <a className="btn sm" href={`${ntfyBase}/${savedTopic}`} target="_blank" rel="noreferrer">Open {savedTopic} in ntfy</a>
            <button type="button" className="btn sm quiet" onClick={() => save({ ntfyTopic: null }).catch(() => {})}>Stop using ntfy</button>
          </div>
        )}
      </div>

      <div className="row wrap" style={{ marginTop: 12, gap: 10 }}>
        <button className="btn" onClick={sendTest}><Icon name="send" size={14} /> Send a test</button>
        {test && (
          <p className="xs" role="status" style={{ color: typeof test === 'string' || test.failed.length ? 'var(--danger)' : 'var(--ok)' }}>
            {typeof test === 'string' ? test : [test.delivered.length ? `Sent to ${test.delivered.join(', ')}` : '', test.failed.length ? `Didn’t reach ${test.failed.join(', ')}` : ''].filter(Boolean).join('. ')}
          </p>
        )}
      </div>
    </section>
  );
}

/** iPhone only gets web push from a Home Screen app. */
export function HomeScreenHint({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <div className="ios-hint" role="note">
      <span className="ico"><Icon name="plus" size={16} /></span>
      <p className="grow">
        <strong>Add Sky to your Home Screen</strong> to get notifications on iPhone. Tap <ShareGlyph /> Share, then <em>Add to Home Screen</em>, and open Sky from there.
      </p>
      {onDismiss && <button className="icon-btn" onClick={onDismiss} aria-label="Dismiss"><Icon name="x" size={16} /></button>}
    </div>
  );
}

const ShareGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ verticalAlign: '-2px' }}>
    <path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
  </svg>
);
