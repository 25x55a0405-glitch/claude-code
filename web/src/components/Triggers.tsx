import { useEffect, useState } from 'react';
import { api, type Task, type TaskTrigger, type TriggerInput, type TriggerKind } from '../api';
import { useAgent } from '../lib/agent';
import { relTime } from '../lib/format';
import { useLiveEvents, useResource } from '../lib/hooks';
import { href } from '../lib/router';
import { Icon } from './Icon';
import { Segmented, useToast } from './ui';

const KINDS: { value: TriggerKind; label: string }[] = [
  { value: 'webhook', label: 'Webhook' },
  { value: 'github', label: 'GitHub' },
  { value: 'message', label: 'A message' },
  { value: 'email', label: 'An email' },
];
const GITHUB_EVENTS = ['push', 'pull_request', 'issues', 'issue_comment', 'release', 'workflow_run'];

export const blankTrigger = (kind: TriggerKind = 'webhook'): TriggerInput => ({ kind, ...(kind === 'message' ? { source: 'any' as const } : {}), ...(kind === 'github' ? { events: [] } : {}) });

/** "When a GitHub push arrives", for chips and cards. */
export function triggerLine(t: Pick<TaskTrigger, 'kind' | 'events' | 'source' | 'match' | 'query' | 'channel'>) {
  if (t.kind === 'webhook') return 'When its webhook is called';
  if (t.kind === 'github') return t.events?.length ? `On GitHub ${t.events.join(', ').replace(/_/g, ' ')}` : 'On any GitHub event';
  if (t.kind === 'email') return t.query ? `When an email matches “${t.query}”` : 'When an email arrives';
  const where = t.source === 'slack' ? 'Slack' : t.source === 'telegram' ? 'Telegram' : 'Slack or Telegram';
  return `When a ${where} message${t.match ? ` says “${t.match}”` : ''} arrives${t.channel ? ` in ${t.channel}` : ''}`;
}

/** The fields for one trigger, shared by New goal and the goal page. */
export function TriggerFields({ value, onChange }: { value: TriggerInput; onChange: (t: TriggerInput) => void }) {
  const { settings } = useAgent();
  const set = (patch: Partial<TriggerInput>) => onChange({ ...value, ...patch });
  return (
    <div className="col">
      <Segmented<TriggerKind> label="What starts it" value={value.kind} onChange={(k) => onChange(blankTrigger(k))} options={KINDS} />
      {value.kind === 'webhook' && <p className="t3 xs">You get a private URL once it’s saved. Anything that POSTs to it starts a run, with what it sent. You need a public address for your Sky server, such as a free Cloudflare Tunnel.</p>}
      {value.kind === 'github' && (
        <div>
          <span className="label">Which events</span>
          <div className="row wrap" style={{ gap: 6 }}>
            {GITHUB_EVENTS.map((ev) => {
              const on = value.events?.includes(ev);
              return <button type="button" key={ev} className={`idea-pill sm ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => set({ events: on ? value.events!.filter((x) => x !== ev) : [...(value.events ?? []), ev] })}>{ev.replace(/_/g, ' ')}</button>;
            })}
          </div>
          <p className="t3 xs" style={{ marginTop: 6 }}>None picked means every event. You’ll get a URL and a secret to paste into the repo’s webhook settings.</p>
        </div>
      )}
      {value.kind === 'message' && (
        <>
          <div>
            <span className="label">Where</span>
            <Segmented<'any' | 'slack' | 'telegram'> label="Where" value={value.source ?? 'any'} onChange={(v) => set({ source: v })} options={[{ value: 'any', label: 'Either' }, { value: 'slack', label: 'Slack' }, { value: 'telegram', label: 'Telegram' }]} />
          </div>
          <div className="grid2">
            <div>
              <label className="label" htmlFor="tr-match">It says <span className="t3">(optional)</span></label>
              <input id="tr-match" className="field" value={value.match ?? ''} onChange={(e) => set({ match: e.target.value || undefined })} placeholder="deploy" />
            </div>
            <div>
              <label className="label" htmlFor="tr-channel">In <span className="t3">(optional)</span></label>
              <input id="tr-channel" className="field mono" value={value.channel ?? ''} onChange={(e) => set({ channel: e.target.value || undefined })} placeholder="#releases or a chat id" spellCheck={false} />
            </div>
          </div>
          <p className="t3 xs">Messages in channels and groups the bot is in, not your own chat with it. Set up the bots in <a href={href('settings')} style={{ textDecoration: 'underline' }}>Settings</a>.</p>
        </>
      )}
      {value.kind === 'email' && (
        <div>
          <label className="label" htmlFor="tr-query">Gmail search</label>
          <input id="tr-query" className="field mono" value={value.query ?? ''} onChange={(e) => set({ query: e.target.value })} placeholder="from:statements@mybank.com has:attachment" spellCheck={false} />
          <p className="t3 xs" style={{ marginTop: 6 }}>Same as the Gmail search box. Checked every {settings?.mailPollMinutes ?? 3} minutes; mail already there doesn’t count.</p>
        </div>
      )}
    </div>
  );
}

const valid = (t: TriggerInput) => t.kind !== 'email' || !!t.query?.trim();

/** On a goal's page: what starts it, the URL to call, and what's waiting. */
export function TriggerPanel({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const toast = useToast();
  const has = !!task.trigger;
  const setup = useResource(() => (has ? api.getTrigger(task.id) : Promise.resolve(null)), [task.id, has, task.trigger?.kind, task.trigger?.fired]);
  const events = useResource(() => (has ? api.listTriggerEvents(task.id) : Promise.resolve([])), [task.id, has, task.trigger?.fired]);
  const [editing, setEditing] = useState<TriggerInput | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);

  useLiveEvents((e) => { if (e.type === 'task.step' && e.data.taskId === task.id) events.reload(); });
  useEffect(() => setShowSecret(false), [setup.data?.secret]);

  if (task.kind === 'one_off') return null;
  const s = setup.data;

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch { toast('Couldn’t copy. Select it and copy instead.'); }
  };
  const save = async (t: TriggerInput | null) => {
    setBusy(true);
    try {
      await api.setTrigger(task.id, t);
      setEditing(null);
      toast(t ? 'Trigger saved' : 'Trigger removed');
      onChanged();
      setup.reload();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const rotate = async () => {
    try { setup.setData(await api.rotateTrigger(task.id)); toast('New URL made. The old one stopped working.'); } catch (e) { toast((e as Error).message); }
  };

  return (
    <section>
      <div className="between" style={{ marginBottom: 10 }}>
        <div className="section-title" style={{ margin: 0 }}>Starts when</div>
        {has && !editing && <button className="btn sm quiet" onClick={() => setEditing(stripCounts(task.trigger!))}>Change</button>}
      </div>

      {editing ? (
        <div className="panel pad col">
          <TriggerFields value={editing} onChange={setEditing} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {has && <><button className="btn quiet danger" onClick={() => save(null)} disabled={busy}>Remove trigger</button><span className="grow" /></>}
            <button className="btn quiet" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn ink" onClick={() => save(editing)} disabled={busy || !valid(editing)}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : !has ? (
        <div className="panel pad between" style={{ gap: 14 }}>
          <p className="t3">{task.schedule ? `Runs ${task.schedule.toLowerCase()}.` : 'Runs on its schedule.'} It can also run when a webhook, a GitHub event, a message or an email arrives.</p>
          <button className="btn sm" onClick={() => setEditing(blankTrigger())}><Icon name="bolt" size={14} /> Add a trigger</button>
        </div>
      ) : (
        <div className="panel">
          <div className="rows">
            <div className="r">
              <span className="glyph"><Icon name="bolt" size={16} /></span>
              <div className="grow" style={{ minWidth: 0 }}>
                <h3>{triggerLine(task.trigger!)}</h3>
                <p className="t3 xs">{task.trigger!.fired ? `Started ${task.trigger!.fired} run${task.trigger!.fired === 1 ? '' : 's'}${task.trigger!.lastFiredAt ? `, last ${relTime(task.trigger!.lastFiredAt)}` : ''}` : 'Hasn’t fired yet'}{task.schedule ? ` · also ${task.schedule.toLowerCase()}` : ''}</p>
              </div>
              {task.trigger!.kind === 'email' && <button className="btn sm quiet" onClick={async () => { try { await api.checkMail(); toast('Checked Gmail'); events.reload(); } catch (e) { toast((e as Error).message); } }}>Check now</button>}
            </div>
            {s?.url && (
              <div className="r col" style={{ alignItems: 'stretch', gap: 8 }}>
                <span className="label" style={{ margin: 0 }}>{task.trigger!.kind === 'github' ? 'Payload URL' : 'Webhook URL'}</span>
                <div className="copy-row">
                  <code className="mono">{s.url}</code>
                  <button className="btn sm" onClick={() => copy(s.url!, 'URL')}>Copy</button>
                </div>
                {s.secret && (
                  <>
                    <span className="label" style={{ margin: '6px 0 0' }}>Secret</span>
                    <div className="copy-row">
                      <code className="mono">{showSecret ? s.secret : '•'.repeat(24)}</code>
                      <button className="btn sm quiet" onClick={() => setShowSecret((v) => !v)}>{showSecret ? 'Hide' : 'Show'}</button>
                      <button className="btn sm" onClick={() => copy(s.secret!, 'Secret')}>Copy</button>
                    </div>
                  </>
                )}
                {/^https?:\/\/(localhost|127\.|\[::1\])/.test(s.url) && <p className="xs" style={{ color: 'var(--warn)' }}>This address only works on the Sky server’s own machine. To call it from GitHub or another service, give the server a public address (a free Cloudflare Tunnel works) and set it as SKY_PUBLIC_URL.</p>}
                <p className="t3 xs">
                  {task.trigger!.kind === 'github' ? 'In the repo: Settings, Webhooks, Add webhook. Content type application/json.' : 'Anyone with this URL can start a run, so keep it private.'}{' '}
                  <button className="link-btn" onClick={rotate}>Make a new URL</button>
                </p>
              </div>
            )}
            <div className="r col" style={{ alignItems: 'stretch', gap: 6 }}>
              <div className="between">
                <span className="label" style={{ margin: 0 }}>Waiting to run</span>
                <span className="t3 xs">Up to 20 wait, and 30 an hour</span>
              </div>
              {(events.data ?? []).length === 0 ? <p className="t3">Nothing waiting. Each event gets its own run.</p> : events.data!.map((ev) => (
                <div key={ev.id} className="row" style={{ gap: 10 }}>
                  <span className="live-dot" />
                  <span className="grow" style={{ fontSize: 14 }}>{ev.summary}</span>
                  <span className="t3 xs">{ev.source} · {relTime(ev.at)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

const stripCounts = ({ fired: _f, lastFiredAt: _l, ...rest }: TaskTrigger): TriggerInput => rest;
