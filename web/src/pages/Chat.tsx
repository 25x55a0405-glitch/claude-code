import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type ConstellationMessage, type Message } from '../api';
import { ApprovalCard } from '../components/ApprovalCard';
import { Avatar } from '../components/Avatar';
import { Composer } from '../components/Composer';
import { TaskInline } from '../components/TaskInline';
import { Rich, StarNote } from '../components/StarNote';
import { Skeleton, StarFace } from '../components/ui';
import { mainStar, useAgent } from '../lib/agent';
import { clockTime, dayLabel } from '../lib/format';
import { useLiveEvents, useResource } from '../lib/hooks';

export function Chat({ conversationId }: { conversationId?: string }) {
  const { settings, stars } = useAgent();
  const convs = useResource(() => api.listConversations(), []);
  const activeId = conversationId ?? convs.data?.find((c) => c.main)?.id;
  const conv = convs.data?.find((c) => c.id === activeId);
  const main = mainStar(stars);
  const star = (conv?.starId && stars?.find((s) => s.id === conv.starId)) || (activeId && stars?.find((s) => s.conversationId === activeId)) || main;
  // A Star's own chat also shows what it says to the other Stars; side chats don't.
  const home = !!star && !!activeId && (star.conversationId === activeId || (star.main && !!conv?.main));
  const notesFor = home && star?.id && (stars?.length ?? 0) > 1 ? star.id : null;
  const [notes, setNotes] = useState<ConstellationMessage[]>([]);
  const tasks = useResource(() => api.listTasks(), [], ['task.updated']);
  const approvals = useResource(() => api.listApprovals(), [], ['approval.created', 'approval.updated']);
  const ideas = useResource(() => api.listIdeas(), []);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [thinking, setThinking] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  useEffect(() => {
    if (!activeId) return;
    setMessages(null);
    first.current = true;
    api.listMessages(activeId).then(setMessages);
  }, [activeId]);

  useEffect(() => {
    setNotes([]);
    if (!notesFor) return;
    api.listConstellationMessages(notesFor).then(setNotes).catch(() => {});
  }, [notesFor]);

  useLiveEvents((e) => {
    if (e.type === 'message.delta' && e.data.conversationId === activeId) {
      setThinking(false);
      setMessages((ms) => {
        if (!ms) return ms;
        if (ms.some((m) => m.id === e.data.messageId)) return ms.map((m) => (m.id === e.data.messageId ? { ...m, content: m.content + e.data.delta } : m));
        return [...ms, { id: e.data.messageId, conversationId: activeId, role: 'agent', content: e.data.delta, createdAt: new Date().toISOString(), status: 'streaming' }];
      });
    }
    if (e.type === 'constellation.message' && notesFor && (e.data.fromStarId === notesFor || e.data.toStarId === notesFor)) {
      const m = e.data;
      setNotes((ns) => (ns.some((n) => n.id === m.id) ? ns : [...ns, m]));
    }
    if (e.type === 'message.done' && e.data.conversationId === activeId) {
      setThinking(false);
      setMessages((ms) => ms && (ms.some((m) => m.id === e.data.id) ? ms.map((m) => (m.id === e.data.id ? e.data : m)) : [...ms, e.data]));
    }
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !messages) return;
    el.scrollTo({ top: el.scrollHeight, behavior: first.current ? 'auto' : 'smooth' });
    first.current = false;
  }, [messages, thinking, notes.length]);

  const send = async (text: string) => {
    if (!activeId) return;
    setSendError(null);
    setThinking(true);
    const before = new Set((messages ?? []).map((x) => x.id));
    try {
      const m = await api.sendMessage(activeId, text);
      // The reply can start streaming before this call returns, so put the
      // user's message ahead of anything that arrived after it was sent.
      setMessages((ms) => {
        const list = (ms ?? []).filter((x) => x.id !== m.id);
        const at = list.findIndex((x) => !before.has(x.id));
        return at === -1 ? [...list, m] : [...list.slice(0, at), m, ...list.slice(at)];
      });
    } catch (e) {
      setThinking(false);
      setSendError(`Couldn’t send that. ${(e as Error).message}`);
      throw e;
    }
  };

  const groups = useMemo(() => {
    const out: { day?: string; m: Message; first: boolean; last: boolean; reached: boolean }[] = [];
    (messages ?? []).forEach((m, i, all) => {
      const prev = all[i - 1];
      const next = all[i + 1];
      const day = dayLabel(m.createdAt);
      const newDay = !prev || dayLabel(prev.createdAt) !== day;
      const gap = (a: Message, b: Message) => Math.abs(new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) > 5 * 60_000;
      const first = newDay || prev.role !== m.role || gap(prev, m);
      const last = !next || next.role !== m.role || dayLabel(next.createdAt) !== day || gap(m, next);
      out.push({ day: newDay ? day : undefined, m, first, last, reached: !!m.proactive && (first || !prev.proactive) });
    });
    return out;
  }, [messages]);

  const name = star?.name ?? settings?.agentName ?? 'Sky';
  const faceOf = (m: Message) => (m.starId && stars?.find((s) => s.id === m.starId)) || star;

  if (messages && messages.length === 0 && notes.length === 0) {
    const sideChat = conv && !conv.main && !home;
    return (
      <div className="scroll">
        <div className="hero">
          {star && <StarFace star={star} size={104} track />}
          <h1>{sideChat ? 'What’s this side chat about?' : star && !star.main ? `What should ${name} take on?` : `What can I take off your plate${settings ? `, ${settings.userName}` : ''}?`}</h1>
          {star && !star.main && !sideChat && <p className="t2" style={{ marginTop: -10 }}>{star.role}</p>}
          <Composer onSend={send} placeholder={`Ask ${name} anything`} autoFocus />
          {sendError && <p className="send-error" role="alert">{sendError}</p>}
          {(!star || star.main) && (
            <div className="ideas-row">
              {ideas.data?.slice(0, 3).map((i) => (
                <button key={i.id} className="idea-pill" onClick={() => send(i.prompt)}>{i.title}</button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Notes between Stars slot in by time, between messages.
  const queue = [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const notesBefore = (at?: string) => {
    const out: ConstellationMessage[] = [];
    while (queue.length && (at === undefined || queue[0].createdAt <= at)) out.push(queue.shift()!);
    return out.map((n) => <StarNote key={n.id} m={n} stars={stars ?? []} />);
  };

  const taskById = (id: string) => tasks.data?.find((t) => t.id === id);
  const approvalById = (id: string) => approvals.data?.find((a) => a.id === id);

  return (
    <>
      <div className="scroll" ref={scroller}>
        <div className="chat-col" aria-live="polite">
          {!messages ? (
            <div style={{ paddingTop: 24 }}><Skeleton h={44} n={4} /></div>
          ) : (
            <>
            {groups.map(({ day, m, first, last, reached }) => (
              <Fragment key={m.id}>
                {notesBefore(m.createdAt)}
                {day && <div className="day">{day}</div>}
                <div className={`m ${m.role} ${first ? 'first' : ''} ${last ? 'last' : ''}`}>
                  {m.role === 'agent' && (
                    <div className="gutter">
                      {last && <Avatar size={28} state={m.status === 'streaming' ? 'working' : 'idle'} character={faceOf(m)?.avatar.character} color={faceOf(m)?.avatar.color} label={faceOf(m)?.name} />}
                    </div>
                  )}
                  <div className="body">
                    {reached && <span className="reached">{name} reached out</span>}
                    {m.content && (
                      <div className="bubble">
                        <Rich text={m.content} />
                        {m.status === 'streaming' && <span className="stream-dot" />}
                      </div>
                    )}
                    {m.cards?.map((c) => {
                      if (c.kind === 'task') {
                        const t = taskById(c.taskId);
                        return t ? <TaskInline key={c.taskId} task={t} /> : null;
                      }
                      const a = approvalById(c.approvalId);
                      return a ? <ApprovalCard key={a.id + a.status} approval={a} compact onDecided={() => approvals.reload()} /> : null;
                    })}
                    {last && m.status !== 'streaming' && <span className="stamp">{clockTime(m.createdAt)}</span>}
                  </div>
                </div>
              </Fragment>
            ))}
            {notesBefore()}
            </>
          )}
          {thinking && (
            <div className="m agent first last">
              <div className="gutter"><Avatar size={28} state="working" character={star?.avatar.character} color={star?.avatar.color} label={name} /></div>
              <div className="body"><div className="bubble typing" aria-label={`${name} is thinking`}><i /><i /><i /></div></div>
            </div>
          )}
        </div>
      </div>
      <div className="dock">
        {sendError && <p className="send-error" role="alert">{sendError}</p>}
        <Composer onSend={send} placeholder={conv && !conv.main && !home ? `Message ${name} in “${conv.title}”` : `Message ${name}`} />
        <div className="hint">{name} keeps working after you close this tab, and asks before anything it can’t undo.</div>
      </div>
    </>
  );
}
