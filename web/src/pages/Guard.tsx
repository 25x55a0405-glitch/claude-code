import { useState } from 'react';
import { api, type ActivityEvent, type GuardMode } from '../api';
import { Icon } from '../components/Icon';
import { Empty, ErrorNote, PageHead, Skeleton, StarFace, useToast } from '../components/ui';
import { useAgent } from '../lib/agent';
import { relTime } from '../lib/format';
import { useResource } from '../lib/hooks';
import { href } from '../lib/router';

const MODES: { value: GuardMode; title: string; body: string }[] = [
  { value: 'model', title: 'Quick checks and a second look', body: 'Before anything reaches other people, deletes, spends or uses the internet from the terminal, a separate model checks it against what you asked for.' },
  { value: 'rules', title: 'Quick checks only', body: 'Catches dangerous commands and hidden instructions with fixed patterns. No extra model calls.' },
  { value: 'off', title: 'Off', body: 'Only your rules and approvals. A page or email that tries to steer a Star has one less thing in its way.' },
];

export type GuardEntry = { id: string; at: string; verdict: 'block' | 'ask'; what: string; reason: string; taskId?: string; starId?: string };

/** "Guard stopped: Run a command (the workspace). The command looks like…" → its parts. */
export function parseGuard(e: ActivityEvent): GuardEntry {
  const m = /^Guard (stopped|asked about): ([\s\S]+?[)…])\.\s+([\s\S]*)$/.exec(e.summary) ?? /^Guard (stopped|asked about): ([\s\S]+?)\.\s+([\s\S]*)$/.exec(e.summary);
  return {
    id: e.id, at: e.at, taskId: e.taskId, starId: e.starId,
    verdict: (m?.[1] ?? (/stopped/i.test(e.summary) ? 'stopped' : 'asked')) === 'stopped' ? 'block' : 'ask',
    what: m?.[2] ?? e.summary,
    reason: m?.[3] ?? '',
  };
}

/** Walks back through Activity for the guard's decisions. */
export async function loadGuardDecisions(max = 60): Promise<GuardEntry[]> {
  const out: GuardEntry[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 8 && out.length < max; page++) {
    const p = await api.listActivity(cursor);
    for (const e of p.items) if (e.kind === 'guard') out.push(parseGuard(e));
    if (!p.nextCursor) break;
    cursor = p.nextCursor;
  }
  return out.slice(0, max);
}

/** What the guard stopped or asked about, with its reasons, and how strict it is. */
export function Guard() {
  const toast = useToast();
  const { settings, setSettings, stars } = useAgent();
  const list = useResource(() => loadGuardDecisions(), [], ['activity']);
  const [show, setShow] = useState<'all' | 'block' | 'ask'>('all');
  const mode = settings?.guard ?? 'model';
  const shown = (list.data ?? []).filter((d) => show === 'all' || d.verdict === show);
  const counts = { block: list.data?.filter((d) => d.verdict === 'block').length ?? 0, ask: list.data?.filter((d) => d.verdict === 'ask').length ?? 0 };

  const setMode = async (g: GuardMode) => {
    try { setSettings(await api.updateSettings({ guard: g })); toast(g === 'off' ? 'Guard off' : MODES.find((m) => m.value === g)!.title); } catch (e) { toast((e as Error).message); }
  };

  return (
    <div className="page">
      <a href={href('permissions')} className="row t3"><Icon name="back" size={14} /> Permissions</a>
      <PageHead title="Safety guard" sub="A second check, separate from the Star doing the work. It looks again before anything that changes something, and can only make things stricter: it stops an action, or turns it into a question for you." />

      <section>
        <div className="section-title">How strict</div>
        <div className="autonomy">
          {MODES.map((m) => (
            <button key={m.value} aria-pressed={mode === m.value} onClick={() => setMode(m.value)}>
              <h3>{m.title}</h3>
              <span>{m.body}</span>
            </button>
          ))}
        </div>
        {mode === 'off' && <p className="xs" style={{ color: 'var(--warn)', marginTop: 10 }}>The guard is off. Your rules and approvals still apply.</p>}
      </section>

      <section>
        <div className="between" style={{ marginBottom: 10 }}>
          <div className="section-title" style={{ margin: 0 }}>What it decided</div>
          {list.data && list.data.length > 0 && (
            <div className="who-filter" role="group" aria-label="Show" style={{ margin: 0 }}>
              <button aria-pressed={show === 'all'} onClick={() => setShow('all')}>All</button>
              <button aria-pressed={show === 'block'} onClick={() => setShow('block')}>Stopped {counts.block > 0 && <span className="t3">{counts.block}</span>}</button>
              <button aria-pressed={show === 'ask'} onClick={() => setShow('ask')}>Asked you {counts.ask > 0 && <span className="t3">{counts.ask}</span>}</button>
            </div>
          )}
        </div>
        {list.error ? <ErrorNote error={list.error} retry={list.reload} /> : !list.data ? <Skeleton h={72} n={3} /> : shown.length === 0 ? (
          <Empty title={list.data.length ? 'None of these' : 'Nothing caught yet'} icon="shield">When the guard stops something or asks you about it, it shows here with its reason. Everything it let through goes on as usual.</Empty>
        ) : (
          <div className="panel">
            <div className="rows">
              {shown.map((d) => {
                const s = d.starId ? stars?.find((x) => x.id === d.starId) : undefined;
                const inner = (
                  <>
                    <span className={`glyph guard-${d.verdict}`}><Icon name={d.verdict === 'block' ? 'x' : 'shield'} size={16} /></span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row wrap" style={{ gap: 8 }}>
                        <span className={`chip ${d.verdict === 'block' ? 'danger' : 'attn'}`}>{d.verdict === 'block' ? 'Stopped' : 'Asked you'}</span>
                        <h3 style={{ overflowWrap: 'anywhere' }}>{d.what}</h3>
                      </div>
                      {d.reason && <p className="t2 guard-reason">{d.reason}</p>}
                      <p className="t3 xs row" style={{ gap: 6, marginTop: 4 }}>
                        {s && <><StarFace star={s} size={16} still />{s.name} ·</>} {relTime(d.at)}{d.taskId && ' · open the goal'}
                      </p>
                    </div>
                  </>
                );
                return d.taskId ? <a key={d.id} className="r guard-row" href={href('goals', d.taskId)}>{inner}</a> : <div key={d.id} className="r guard-row">{inner}</div>;
              })}
            </div>
          </div>
        )}
        <p className="t3 xs" style={{ marginTop: 10 }}>When it asks, the action waits in <a href={href('approvals')} style={{ textDecoration: 'underline' }}>Approvals</a> with the guard’s reason, even if the Star is hands-off.</p>
      </section>

      <section>
        <div className="section-title">What it checks</div>
        <div className="panel">
          <div className="rows">
            <div className="r guard-rule">
              <span className="glyph guard-block"><Icon name="x" size={16} /></span>
              <div className="grow">
                <h3>Always stops</h3>
                <p className="t3">Commands that delete everything, fork bombs, writing straight to a disk, and opening a remote shell.</p>
              </div>
            </div>
            <div className="r guard-rule">
              <span className="glyph guard-ask"><Icon name="shield" size={16} /></span>
              <div className="grow">
                <h3>Asks you</h3>
                <p className="t3">Running a script straight from the internet, admin rights (sudo), leaving something running in the background, anything about to go out with text that tries to give an assistant instructions, and long blocks of encoded data leaving in a send.</p>
              </div>
            </div>
            <div className="r guard-rule">
              <span className="glyph"><Icon name="eye" size={16} /></span>
              <div className="grow">
                <h3>Second look{mode !== 'model' && <span className="chip" style={{ marginLeft: 8 }}>Off</span>}</h3>
                <p className="t3">Sends, deletes, spending, commands with internet and tool writes go to a separate small model. It sees only what you asked for and the action, never the pages, mail or messages the Star read, so instructions hidden in those can’t talk it round. If it can’t answer, it asks you.</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
