import { useState } from 'react';
import { api, type HighlightKind } from '../api';
import { Icon, type IconName } from '../components/Icon';
import { ApprovalCard } from '../components/ApprovalCard';
import { TaskCard } from '../components/TaskCard';
import { ErrorNote, Orb, Skeleton, stateLabel } from '../components/ui';
import { relTime } from '../lib/format';
import { useResource } from '../lib/hooks';
import { href, navigate } from '../lib/router';
import { useStatus } from '../lib/status';

const highlightIcon: Record<HighlightKind, IconName> = {
  done: 'check',
  found: 'sparkle',
  needs_you: 'bolt',
  upcoming: 'calendar',
  warning: 'alert',
};

const SUGGESTIONS = [
  'Every Friday, summarise what I shipped this week',
  'Find a quiet coworking space near me',
  'Watch for replies from Maya and tell me right away',
];

export function Home() {
  const status = useStatus();
  const briefing = useResource(() => api.getBriefing(), []);
  const tasks = useResource(() => api.listTasks({ status: ['active', 'waiting_approval', 'blocked'] }), [], ['task.updated']);
  const approvals = useResource(() => api.listApprovals('pending'), [], ['approval.created', 'approval.updated']);
  const [ask, setAsk] = useState('');

  const start = async (text: string) => {
    if (!text.trim()) return;
    const convs = await api.listConversations();
    const conv = convs[0] ?? (await api.createConversation());
    await api.sendMessage(conv.id, text.trim());
    navigate('chat', conv.id);
  };

  const b = briefing.data;
  return (
    <div className="page">
      <section className="hero">
        <Orb state={status?.state ?? 'idle'} size="lg" />
        <div>
          {b ? (
            <>
              <h1>{b.greeting}</h1>
              <p className="summary">{b.summary}</p>
            </>
          ) : (
            <Skeleton h={28} n={2} />
          )}
          {status && (
            <div className="row now">
              <span className={`pill ${status.state === 'waiting' ? 'dawn' : status.state === 'working' ? 'sky' : ''}`}>
                <span className="dot" />
                {stateLabel[status.state]}
              </span>
              <span className="muted">{status.activity ?? 'Watching for changes'}</span>
            </div>
          )}
        </div>
      </section>

      <form
        className="quick-ask"
        onSubmit={(e) => {
          e.preventDefault();
          start(ask);
        }}
      >
        <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Give Skys something to take care of…" aria-label="Ask Skys" />
        <button className="btn btn-primary" type="submit" disabled={!ask.trim()}>
          <Icon name="send" size={16} /> Ask
        </button>
      </form>
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="suggestion" onClick={() => start(s)}>{s}</button>
        ))}
      </div>

      {status && (
        <div className="grid-3 stats">
          <a className="card tight stat" href={href('tasks')}>
            <span className="n">{status.counts.activeTasks}</span>
            <span className="k">Tasks in progress</span>
          </a>
          <a className="card tight stat" href={href('approvals')}>
            <span className="n" style={{ color: status.counts.pendingApprovals ? 'var(--dawn)' : undefined }}>{status.counts.pendingApprovals}</span>
            <span className="k">Waiting on your OK</span>
          </a>
          <a className="card tight stat" href={href('activity')}>
            <span className="n">{status.counts.completedToday}</span>
            <span className="k">Finished recently</span>
          </a>
        </div>
      )}

      {approvals.data && approvals.data.length > 0 && (
        <section className="stack">
          <div className="row-between">
            <h2>Needs you</h2>
            <a className="faint" href={href('approvals')}>See all</a>
          </div>
          <ApprovalCard approval={approvals.data[0]} onDecided={approvals.reload} />
        </section>
      )}

      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Today’s briefing</h2>
            {b && <span className="faint">Prepared {relTime(b.generatedAt)}</span>}
          </div>
          {briefing.error ? (
            <ErrorNote error={briefing.error} retry={briefing.reload} />
          ) : !b ? (
            <Skeleton h={44} n={4} />
          ) : (
            <div className="stack-lg">
              {b.highlights.map((h) => {
                const link = h.approvalId ? href('approvals') : h.taskId ? href('tasks', h.taskId) : undefined;
                const body = (
                  <div className="highlight" data-kind={h.kind}>
                    <div className="icon-tile"><Icon name={highlightIcon[h.kind]} size={16} /></div>
                    <div>
                      <h3>{h.title}</h3>
                      <p className="faint">{h.detail}</p>
                    </div>
                  </div>
                );
                return link ? <a key={h.id} href={link}>{body}</a> : <div key={h.id}>{body}</div>;
              })}
            </div>
          )}
        </section>

        <section className="stack">
          <div className="row-between">
            <h2>Working on</h2>
            <a className="faint" href={href('tasks')}>All tasks</a>
          </div>
          {tasks.error ? (
            <ErrorNote error={tasks.error} retry={tasks.reload} />
          ) : !tasks.data ? (
            <Skeleton h={110} n={3} />
          ) : (
            tasks.data.slice(0, 4).map((t) => <TaskCard key={t.id} task={t} />)
          )}
        </section>
      </div>
    </div>
  );
}
