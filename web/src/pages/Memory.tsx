import { useMemo, useState } from 'react';
import { api, type MemoryCategory, type MemoryItem } from '../api';
import { Icon } from '../components/Icon';
import { Empty, ErrorNote, PageHead, Segmented, Skeleton, useToast } from '../components/ui';
import { relTime } from '../lib/format';
import { useResource } from '../lib/hooks';

const CATS: { value: MemoryCategory; label: string }[] = [
  { value: 'preference', label: 'Preferences' },
  { value: 'person', label: 'People' },
  { value: 'goal', label: 'Goals' },
  { value: 'style', label: 'How you write' },
  { value: 'fact', label: 'Facts' },
];

export function Memory() {
  const toast = useToast();
  const mem = useResource(() => api.listMemory(), [], ['memory.learned']);
  const [cat, setCat] = useState<MemoryCategory | 'all'>('all');
  const [adding, setAdding] = useState('');
  const [addCat, setAddCat] = useState<MemoryCategory>('preference');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const items = useMemo(() => {
    const list = (mem.data ?? []).filter((m) => cat === 'all' || m.category === cat);
    return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt));
  }, [mem.data, cat]);

  const patch = async (m: MemoryItem, p: Partial<MemoryItem>) => {
    const u = await api.updateMemory(m.id, p);
    mem.setData((d) => d && d.map((x) => (x.id === m.id ? u : x)));
  };

  return (
    <div className="page">
      <PageHead title="Memory" sub="What Skys knows about you. Change or delete anything and it takes effect right away." />

      <form
        className="composer"
        style={{ maxWidth: 'none', boxShadow: 'none' }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!adding.trim()) return;
          const m = await api.addMemory({ category: addCat, content: adding.trim() });
          mem.setData((d) => [m, ...(d ?? [])]);
          setAdding('');
          toast('Remembered');
        }}
      >
        <input id="mem-new" style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', padding: '8px 0' }} value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Tell Skys something to remember" aria-label="New memory" />
        <select id="mem-cat" value={addCat} onChange={(e) => setAddCat(e.target.value as MemoryCategory)} aria-label="Kind" style={{ border: 'none', background: 'transparent', color: 'var(--text-2)', fontSize: 13 }}>
          {CATS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <button className="send" disabled={!adding.trim()} aria-label="Remember"><Icon name="up" size={18} /></button>
      </form>

      <Segmented label="Kind" value={cat} onChange={setCat} options={[{ value: 'all', label: 'All' }, ...CATS]} />

      {mem.error ? (
        <ErrorNote error={mem.error} retry={mem.reload} />
      ) : !mem.data ? (
        <Skeleton h={56} n={5} />
      ) : items.length === 0 ? (
        <Empty title="Nothing remembered here yet" />
      ) : (
        <div className="panel">
          <div className="rows">
            {items.map((m) => (
              <div key={m.id} className="r" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  {editing === m.id ? (
                    <form className="row" onSubmit={async (e) => { e.preventDefault(); await patch(m, { content: editText }); setEditing(null); }}>
                      <input id={`mem-edit-${m.id}`} className="field" autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} aria-label="Edit memory" />
                      <button className="btn ink sm">Save</button>
                    </form>
                  ) : (
                    <p>{m.pinned && <Icon name="pin" size={13} className="pin" />} {m.content}</p>
                  )}
                  <p className="t3 xs" style={{ marginTop: 3 }}>{CATS.find((c) => c.value === m.category)?.label} · {m.source} · {relTime(m.createdAt)}</p>
                </div>
                <div className="row" style={{ gap: 0 }}>
                  <button className="icon-btn" onClick={() => patch(m, { pinned: !m.pinned })} aria-pressed={m.pinned} aria-label={m.pinned ? 'Unpin' : 'Pin'} style={m.pinned ? { color: 'var(--text)' } : undefined}><Icon name="pin" size={16} /></button>
                  <button className="icon-btn" onClick={() => { setEditing(m.id); setEditText(m.content); }} aria-label="Edit"><Icon name="edit" size={16} /></button>
                  <button className="icon-btn" aria-label="Forget" onClick={async () => { await api.deleteMemory(m.id); mem.setData((d) => d && d.filter((x) => x.id !== m.id)); toast('Forgotten'); }}><Icon name="trash" size={16} /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
