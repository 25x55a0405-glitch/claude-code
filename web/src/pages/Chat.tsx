import { useEffect, useRef, useState } from 'react';
import { api, type Message } from '../api';
import { Icon } from '../components/Icon';
import { Orb, Skeleton, stateLabel } from '../components/ui';
import { clockTime, relTime, renderInline } from '../lib/format';
import { useLiveEvents, useResource } from '../lib/hooks';
import { href, navigate } from '../lib/router';
import { useStatus } from '../lib/status';

function Rich({ text }: { text: string }) {
  return (
    <>
      {renderInline(text).map((part, i) =>
        typeof part === 'string' ? part : part.b !== undefined ? <strong key={i}>{part.b}</strong> : <code key={i}>{part.code}</code>,
      )}
    </>
  );
}

export function Chat({ conversationId }: { conversationId?: string }) {
  const status = useStatus();
  const convs = useResource(() => api.listConversations(), [], ['message.done']);
  const activeId = conversationId ?? convs.data?.[0]?.id;
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [draft, setDraft] = useState('');
  const [awaiting, setAwaiting] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeId) return;
    setMessages(null);
    api.listMessages(activeId).then(setMessages);
  }, [activeId]);

  useLiveEvents((e) => {
    if (e.type === 'message.delta' && e.data.conversationId === activeId) {
      setAwaiting(false);
      setMessages((ms) => {
        if (!ms) return ms;
        const existing = ms.find((m) => m.id === e.data.messageId);
        if (existing) return ms.map((m) => (m.id === e.data.messageId ? { ...m, content: m.content + e.data.delta } : m));
        return [...ms, { id: e.data.messageId, conversationId: activeId, role: 'agent', content: e.data.delta, createdAt: new Date().toISOString(), status: 'streaming' }];
      });
    }
    if (e.type === 'message.done' && e.data.conversationId === activeId) {
      setMessages((ms) => ms && (ms.some((m) => m.id === e.data.id) ? ms.map((m) => (m.id === e.data.id ? e.data : m)) : [...ms, e.data]));
    }
  });

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages, awaiting]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !activeId) return;
    setDraft('');
    setAwaiting(true);
    const m = await api.sendMessage(activeId, text);
    setMessages((ms) => [...(ms ?? []), m]);
  };

  const newConversation = async () => {
    const c = await api.createConversation();
    convs.reload();
    navigate('chat', c.id);
  };

  const current = convs.data?.find((c) => c.id === activeId);

  return (
    <div className="chat">
      <aside className="convs" aria-label="Conversations">
        <button className="btn" onClick={newConversation}><Icon name="plus" size={16} /> New chat</button>
        {convs.data?.map((c) => (
          <a key={c.id} href={href('chat', c.id)} className={`conv ${c.id === activeId ? 'active' : ''}`}>
            <div className="row-between"><span className="t">{c.title}</span><span className="faint">{relTime(c.updatedAt)}</span></div>
            <div className="p">{c.preview || 'No messages yet'}</div>
          </a>
        ))}
      </aside>

      <section className="thread">
        <header className="thread-head">
          <Orb state={status?.state ?? 'idle'} size="sm" />
          <div style={{ minWidth: 0 }}>
            <h3>{current?.title ?? 'Skys'}</h3>
            <p className="faint">{status ? `${stateLabel[status.state]} · ${status.activity ?? 'Watching for changes'}` : '…'}</p>
          </div>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={newConversation} aria-label="New chat"><Icon name="plus" size={14} /></button>
        </header>

        <div className="messages" ref={scroller} aria-live="polite">
          {!messages ? (
            <Skeleton h={48} n={3} />
          ) : messages.length === 0 ? (
            <div className="empty">
              <Orb state="idle" size="md" />
              <h3>What should I take care of?</h3>
              <p className="faint">Ask once, and I’ll keep working on it in the background, even when you close this tab.</p>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                {m.role === 'agent' && <Orb state={m.status === 'streaming' ? 'working' : 'idle'} size="xs" />}
                <div>
                  <div className="bubble">
                    <Rich text={m.content} />
                    {m.status === 'streaming' && <span className="caret" />}
                  </div>
                  {m.taskIds?.map((id) => (
                    <a key={id} className="task-chip" href={href('tasks', id)}><Icon name="tasks" size={13} /> View task</a>
                  ))}
                  <div className="meta">{clockTime(m.createdAt)}</div>
                </div>
              </div>
            ))
          )}
          {awaiting && (
            <div className="msg agent">
              <Orb state="working" size="xs" />
              <div className="bubble typing" aria-label="Skys is typing"><span /><span /><span /></div>
            </div>
          )}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            rows={1}
            value={draft}
            placeholder="Message Skys"
            aria-label="Message Skys"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="btn btn-primary btn-icon" type="submit" disabled={!draft.trim()} aria-label="Send">
            <Icon name="send" size={16} />
          </button>
        </form>
      </section>
    </div>
  );
}
