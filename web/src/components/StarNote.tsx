import type { ConstellationMessage, StarView } from '../api';
import { relTime, renderInline } from '../lib/format';
import { href } from '../lib/router';
import { StarFace } from './ui';

/** Chat text with **bold** and `code`. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {renderInline(text).map((p, i) => (typeof p === 'string' ? p : p.b !== undefined ? <strong key={i}>{p.b}</strong> : <code key={i}>{p.code}</code>))}
    </>
  );
}

const VERB: Record<ConstellationMessage['kind'], string> = { request: 'asked', reply: 'answered', handoff: 'handed work to', message: 'told' };

/** One Star talking to another: an ask, an answer, a hand-off or a heads-up. */
export function StarNote({ m, stars }: { m: ConstellationMessage; stars: StarView[] }) {
  const from = stars.find((s) => s.id === m.fromStarId);
  const to = stars.find((s) => s.id === m.toStarId);
  if (!from || !to) return null;
  return (
    <div className="cm" data-kind={m.kind}>
      <div className="cm-head">
        <span className="cm-faces"><StarFace star={from} size={20} still /><StarFace star={to} size={20} still /></span>
        <span className="grow"><strong>{from.name}</strong> {VERB[m.kind]} <strong>{to.name}</strong></span>
        <span className="t3 xs">{relTime(m.createdAt)}</span>
      </div>
      <p className="cm-body"><Rich text={m.content} /></p>
      {m.taskId && (m.kind === 'handoff' || m.kind === 'request') && <a className="cm-link" href={href('goals', m.taskId)}>Follow this goal</a>}
    </div>
  );
}
