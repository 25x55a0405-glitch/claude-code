import { useMemo } from 'react';
import { api, type ConstellationMessage, type StarView } from '../api';
import { Icon } from '../components/Icon';
import { StarNote } from '../components/StarNote';
import { Empty, PageHead, Skeleton, StarFace, useToast } from '../components/ui';
import { starChat, starLine, useAgent } from '../lib/agent';
import { useResource } from '../lib/hooks';
import { href } from '../lib/router';

const AUTONOMY = { ask: 'Asks first', balanced: 'Balanced', autonomous: 'Independent' } as const;

/** Where each Star sits on the map: the main Star on top or in the middle, the rest around it. */
function layout(stars: StarView[]) {
  const others = stars.filter((s) => !s.main);
  const main = stars.find((s) => s.main);
  const pos = new Map<string, { x: number; y: number }>();
  const n = others.length;
  if (n <= 3) {
    if (main) pos.set(main.id, { x: 50, y: n ? 30 : 50 });
    others.forEach((s, i) => {
      const x = n === 1 ? 50 : 22 + (56 * i) / (n - 1);
      pos.set(s.id, { x, y: n === 3 && i === 1 ? 76 : 70 });
    });
  } else {
    if (main) pos.set(main.id, { x: 50, y: 50 });
    others.forEach((s, i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      pos.set(s.id, { x: 50 + Math.cos(a) * 38, y: 50 + Math.sin(a) * 36 });
    });
  }
  return pos;
}

/** A fixed scatter of faint stars behind the Stars, so the map reads as sky and not as a graph. */
const FIELD: [number, number, number, number][] = Array.from({ length: 34 }, (_, i) => {
  const a = Math.sin(i * 12.9898) * 43758.5453;
  const b = Math.sin(i * 78.233) * 12345.6789;
  const f = (v: number) => v - Math.floor(v);
  return [3 + f(a) * 94, 4 + f(b) * 92, 0.18 + f(a * b) * 0.32, f(a + b) * 6];
});

function SkyMap({ stars, notes }: { stars: StarView[]; notes: ConstellationMessage[] }) {
  const pos = useMemo(() => layout(stars), [stars]);
  const links = useMemo(() => {
    const m = new Map<string, { a: string; b: string; n: number; last: string }>();
    for (const n of notes) {
      const [a, b] = [n.fromStarId, n.toStarId].sort();
      const k = a + b;
      const cur = m.get(k) ?? { a, b, n: 0, last: '' };
      cur.n++;
      if (n.createdAt > cur.last) cur.last = n.createdAt;
      m.set(k, cur);
    }
    return [...m.values()];
  }, [notes]);
  const recent = Date.now() - 10 * 60_000;

  return (
    <div className="skymap" role="img" aria-label={`${stars.length} Stars and how they work together`}>
      <div className="starfield" aria-hidden="true">
        {FIELD.map(([x, y, r, d], i) => <i key={i} style={{ left: `${x}%`, top: `${y}%`, width: r * 6, height: r * 6, animationDelay: `${d}s` }} />)}
      </div>
      <svg className="links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {links.map((l) => {
          const p = pos.get(l.a);
          const q = pos.get(l.b);
          if (!p || !q) return null;
          return <line key={l.a + l.b} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className={new Date(l.last).getTime() > recent ? 'live' : ''} style={{ strokeOpacity: Math.min(0.25 + l.n * 0.12, 0.7) }} vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
      {stars.map((s) => {
        const p = pos.get(s.id)!;
        return (
          <a key={s.id} className="node" data-av={s.avatar.color} href={starChat(s)} style={{ left: `${p.x}%`, top: `${p.y}%` }} aria-label={`${s.name}’s chat`}>
            <StarFace star={s} size={s.main ? 64 : 52} />
            <span className="nm">{s.name}</span>
          </a>
        );
      })}
    </div>
  );
}

export function Constellation() {
  const { stars, status, upsertStar } = useAgent();
  const toast = useToast();
  const notes = useResource(() => api.listConstellationMessages(), [], ['constellation.message', 'star.deleted']);
  const allPaused = status?.state === 'paused';

  const pause = async (s: StarView) => {
    try { upsertStar(await api.pauseStar(s.id, !s.paused)); } catch (e) { toast((e as Error).message); }
  };

  if (!stars) return <div className="page"><Skeleton h={220} n={2} /></div>;
  const feed = [...(notes.data ?? [])].reverse();

  return (
    <div className="page">
      <PageHead title="Your constellation" sub="Each Star has one job. They ask each other for help, hand work over and keep each other posted, and every one of them still asks you before anything it can’t undo.">
        <div className="row">
          <button className="btn" onClick={() => api.setPaused(!allPaused)}>
            <Icon name={allPaused ? 'play' : 'pause'} size={15} />
            {allPaused ? 'Wake every Star' : 'Pause every Star'}
          </button>
          <a className="btn" href={href('stars', 'templates')}>Templates</a>
          <a className="btn ink" href={href('stars', 'new')}><Icon name="plus" size={15} /> New Star</a>
        </div>
      </PageHead>

      <SkyMap stars={stars} notes={notes.data ?? []} />

      <section>
        <div className="section-title">Stars</div>
        <div className="star-grid">
          {stars.map((s) => (
            <article key={s.id} className="panel star-card">
              <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                <StarFace star={s} size={44} />
                <div className="grow">
                  <div className="row" style={{ gap: 6 }}>
                    <h3>{s.name}</h3>
                    {s.main && <span className="chip">Main</span>}
                    {s.status.pendingApprovals > 0 && <span className="chip attn">{s.status.pendingApprovals} need{s.status.pendingApprovals === 1 ? 's' : ''} you</span>}
                  </div>
                  <p className="t2" style={{ fontSize: 14 }}>{s.role}</p>
                </div>
              </div>
              <p className={`xs ${s.status.state === 'working' && !allPaused ? 'shimmer' : 't3'}`} style={{ fontSize: 12.5 }}>{starLine(s.status, status)}</p>
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="chip">{s.autonomy ? AUTONOMY[s.autonomy] : 'Follows your setting'}</span>
                <span className="chip">{s.connectionIds === null ? 'All your apps' : s.connectionIds.length === 0 ? 'No apps' : `${s.connectionIds.length} app${s.connectionIds.length === 1 ? '' : 's'}`}</span>
                {s.providerIds && s.providerIds.length > 0 && <span className="chip">Its own models</span>}
                {s.status.activeTasks > 0 && <span className="chip">{s.status.activeTasks} on the go</span>}
              </div>
              <div className="row wrap">
                <a className="btn sm ink" href={starChat(s)}>Chat</a>
                <a className="btn sm" href={href('stars', s.id)}>Edit</a>
                {!s.main || stars.length > 1 ? (
                  <button className="btn sm quiet" onClick={() => pause(s)} disabled={allPaused}>
                    <Icon name={s.paused ? 'play' : 'pause'} size={13} />{s.paused ? 'Wake' : 'Pause'}
                  </button>
                ) : null}
              </div>
            </article>
          ))}
          <a className="panel star-card add" href={href('stars', 'new')}>
            <span className="plus"><Icon name="plus" size={18} /></span>
            <h3>Add a Star</h3>
            <p className="t3">Give a job its own Star, like research, your inbox or your calendar.</p>
          </a>
        </div>
      </section>

      <section>
        <div className="section-title">Between Stars</div>
        {notes.data && feed.length === 0 ? (
          <Empty title="Quiet so far" icon="sparkle">When your Stars ask each other something or hand work over, it shows up here and in their chats.</Empty>
        ) : (
          <div className="col">
            {feed.map((m) => <StarNote key={m.id} m={m} stars={stars} />)}
          </div>
        )}
      </section>
    </div>
  );
}
