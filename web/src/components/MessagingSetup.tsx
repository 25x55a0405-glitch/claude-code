import { useEffect, useState } from 'react';
import { api, type MessagingApp, type MessagingStatus } from '../api';
import { useAgent } from '../lib/agent';
import { useLiveEvents, useResource } from '../lib/hooks';
import { Icon } from './Icon';
import { StarFace, useToast } from './ui';

const NAME: Record<MessagingApp, string> = { telegram: 'Telegram', slack: 'Slack' };

/** Two-way Telegram and Slack: connect a bot, pair with a code, then talk to any Star. */
export function MessagingSetup() {
  const { stars } = useAgent();
  const list = useResource(() => api.listMessaging(), []);
  useLiveEvents((e) => {
    if (e.type === 'messaging.updated') list.setData((d) => d && d.map((m) => (m.app === e.data.app ? e.data : m)));
  });
  if (list.error || !list.data) return null;
  const on = list.data.some((m) => m.state === 'on');

  return (
    <section>
      <div className="section-title">Chat apps</div>
      <p className="t3" style={{ marginBottom: 12 }}>Talk to your Stars from Telegram or Slack, and approve things from there. Neither needs a public address for your server.</p>
      <div className="col">
        {list.data.map((m) => <AppCard key={m.app} m={m} onChange={(n) => list.setData((d) => d && d.map((x) => (x.app === n.app ? n : x)))} />)}
      </div>
      {on && stars && stars.length > 0 && (
        <div className="panel pad col" style={{ marginTop: 12 }}>
          <h3>Who answers there</h3>
          <p className="t3">Start a message with a Star’s name to pick who answers. Otherwise the last Star you talked to there replies. Send /stars for the list.</p>
          <div className="reach">
            {stars.map((s) => (
              <div key={s.id} className="row" style={{ gap: 10 }}>
                <StarFace star={s} size={22} still />
                <span className="grow">{s.name}</span>
                <code className="mono t3">{s.name}: …</code>
                <code className="mono t3">@{s.name}</code>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function AppCard({ m, onChange }: { m: MessagingStatus; onChange: (m: MessagingStatus) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [bot, setBot] = useState('');
  const [appToken, setAppToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<string | null>(null);
  const name = NAME[m.app];

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = m.app === 'telegram' ? await api.connectTelegram(bot.trim()) : await api.connectSlack(bot.trim(), appToken.trim());
      setBot(''); setAppToken(''); setOpen(false);
      onChange(r);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const disconnect = async () => {
    try { onChange(await api.disconnectMessaging(m.app)); toast(`${name} disconnected`); } catch (e) { toast((e as Error).message); }
  };
  const newCode = async () => {
    try { onChange(await api.newPairCode(m.app)); } catch (e) { toast((e as Error).message); }
  };
  const getManifest = async () => {
    try {
      const text = await api.slackManifest();
      setManifest(text);
      await navigator.clipboard.writeText(text).then(() => toast('Manifest copied'), () => {});
    } catch (e) { toast((e as Error).message); }
  };

  return (
    <div className="panel pad col app-card">
      <div className="row" style={{ gap: 12 }}>
        <span className="app-logo" style={{ background: m.app === 'telegram' ? '#229ed9' : '#4a154b' }}>{name[0]}</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <h3>{name}</h3>
          <p className="t3 xs">
            {m.state === 'on' ? `Connected${m.botName ? ` as ${m.app === 'telegram' ? '@' : ''}${m.botName}` : ''}. Only you can reach your Stars there.` : m.state === 'pairing' ? 'Waiting for the pairing code' : m.state === 'error' ? m.error ?? 'Something went wrong' : 'Not connected'}
          </p>
        </div>
        {m.state === 'on' && <span className="chip ok"><span className="dot" />On</span>}
        {m.state === 'error' && <span className="chip danger"><span className="dot" />Needs fixing</span>}
        {m.state === 'off' && !open && <button className="btn sm" onClick={() => setOpen(true)}>Connect</button>}
        {(m.state === 'on' || m.state === 'error') && <button className="btn sm quiet" onClick={disconnect}>Disconnect</button>}
      </div>

      {m.state === 'pairing' && m.pairCode && (
        <div className="pairing">
          <p className="t2" style={{ fontSize: 14 }}>Send exactly this code to {m.botName ? `${m.app === 'telegram' ? '@' : ''}${m.botName}` : 'your bot'}{m.app === 'slack' ? ' in a direct message' : ''}, with nothing else in the message:</p>
          <div className="code" aria-label={`Pairing code ${m.pairCode.split('').join(' ')}`}>{m.pairCode.split('').map((c, i) => <span key={i}>{c}</span>)}</div>
          <div className="row wrap" style={{ gap: 8, justifyContent: 'center' }}>
            {m.pairLink && <a className="btn ink sm" href={m.pairLink} target="_blank" rel="noreferrer">Open in Telegram</a>}
            <button className="btn sm quiet" onClick={disconnect}>Cancel</button>
          </div>
          <p className="t3 xs">This screen updates by itself once it’s paired.{m.pairExpiresAt && <> <Expires at={m.pairExpiresAt} onExpired={newCode} /></>}</p>
        </div>
      )}
      {m.state === 'pairing' && !m.pairCode && (
        <div className="pairing">
          <p className="t2" style={{ fontSize: 14 }}>{m.pairLocked ? 'That code stopped working after too many wrong tries, so nobody can guess their way in.' : 'That code ran out before it was sent.'}</p>
          <div className="row wrap" style={{ gap: 8, justifyContent: 'center' }}>
            <button className="btn ink sm" onClick={newCode}>Make a new code</button>
            <button className="btn sm quiet" onClick={disconnect}>Cancel</button>
          </div>
        </div>
      )}

      {open && m.state === 'off' && (
        <form className="col" onSubmit={(e) => { e.preventDefault(); connect(); }} autoComplete="off">
          {m.app === 'telegram' ? (
            <ol className="how">
              <li>In Telegram, message <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> and send <code className="mono">/newbot</code>.</li>
              <li>Pick a name, then paste the token it gives you here.</li>
            </ol>
          ) : (
            <ol className="how">
              <li><button type="button" className="link-btn" onClick={getManifest}>Copy the app manifest</button>, then at <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">api.slack.com/apps</a> choose Create an app, From a manifest, and paste it.</li>
              <li>Install it to your workspace and copy the Bot token (xoxb-).</li>
              <li>Under Basic Information, make an app-level token with connections:write (xapp-).</li>
            </ol>
          )}
          {manifest && <pre className="steps-view manifest">{manifest}</pre>}
          <div>
            <label className="label" htmlFor={`${m.app}-bot`}>{m.app === 'telegram' ? 'Bot token' : 'Bot token (xoxb-)'}</label>
            <input id={`${m.app}-bot`} className="field mono" type="password" autoComplete="new-password" spellCheck={false} value={bot} onChange={(e) => setBot(e.target.value)} placeholder={m.app === 'telegram' ? '123456789:AA…' : 'xoxb-…'} />
          </div>
          {m.app === 'slack' && (
            <div>
              <label className="label" htmlFor="slack-app">App-level token (xapp-)</label>
              <input id="slack-app" className="field mono" type="password" autoComplete="new-password" spellCheck={false} value={appToken} onChange={(e) => setAppToken(e.target.value)} placeholder="xapp-…" />
            </div>
          )}
          {m.app === 'telegram' && <p className="t3 xs">In groups the bot only sees every message if you turn its privacy mode off in @BotFather.</p>}
          {error && <p className="send-error" role="alert" style={{ margin: 0 }}>{error}</p>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn quiet" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
            <button type="submit" className="btn ink" disabled={busy || !bot.trim() || (m.app === 'slack' && !appToken.trim())}>{busy ? 'Connecting…' : 'Connect'}</button>
          </div>
        </form>
      )}
      {m.state !== 'off' && m.state !== 'pairing' && <p className="t3 xs"><Icon name="lock" size={12} /> Tokens stay on your Sky server.</p>}
    </div>
  );
}

/** "Works for 9 more minutes", ticking down; offers a new code once it runs out. */
function Expires({ at, onExpired }: { at: string; onExpired: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 15_000); return () => window.clearInterval(t); }, []);
  const left = Math.ceil((new Date(at).getTime() - now) / 60_000);
  if (left <= 0) return <>It has run out. <button className="link-btn" onClick={onExpired}>Make a new code</button></>;
  return <>Works for {left} more minute{left === 1 ? '' : 's'}.</>;
}
