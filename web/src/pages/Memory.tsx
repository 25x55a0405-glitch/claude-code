import { useMemo, useState } from 'react';
import { api, type MemoryCategory, type MemoryItem } from '../api';
import { Icon, type IconName } from '../components/Icon';
import { Empty, ErrorNote, Segmented, Skeleton, useToast } from '../components/ui';
import { relTime } from '../lib/format';
import { useResource } from '../lib/hooks';

const CATS: { value: MemoryCategory; label: string; icon: IconName }[] = [
  { value: 'preference', label: 'Preferences', icon: 'sparkle' },
  { value: 'person', label: 'People', icon: 'chat' },
  { value: 'goal', label: 'Goals', icon: 'flag' },
  { value: 'style', label: 'How you write', icon: 'edit' },
  { value: 'fact', label: 'Facts', icon: 'note' },
];

export function Memory() {
  const toast = useToast();
  const mem = useResource(() => api.listMemory(), [], ['memory.learned']);
  const [cat, setCat] = useState<MemoryCategory | 'all'>('all');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState('');
  const [addCat, setAddCat] = useState<MemoryCategory>('preference');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const items = useMemo(() => {
    const list = (mem.data ?? []).filter((m) => (cat === 'all' || m.category === cat) && m.content.toLowerCase().includes(q.toLowerCase()));
    return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt));
  }, [mem.data, cat, q]);

  const patch = async (m: MemoryItem, p: Partial<MemoryItem>) => {
    const updated = await api.updateMemory(m.id, p);
    mem.setData((d) => d && d.map((x) => (x.id === m.id ? updated : x)));
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Memory</h1>
          <p className="sub">What Skys has learned about you. Edit or delete anything, and it changes how Skys works right away.</p>
        </div>
      </div>

      <form
        className="quick-ask"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!adding.trim()) return;
          const m = await api.addMemory({ category: addCat, content: adding.trim() });
          mem.setData((d) => [m, ...(d ?? [])]);
          setAdding('');
          toast('Skys will remember that');
        }}
      >
        <select className="field" style={{ width: 'auto', border: 'none', background: 'transparent' }} value={addCat} onChange={(e) => setAddCat(e.target.value as MemoryCategory)} aria-label="Category">
          {CATS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Tell Skys something to remember…" aria-label="New memory" />
        <button className="btn btn-primary" disabled={!adding.trim()}><Icon name="plus" size={16} /> Remember</button>
      </form>

      <div className="row-between" style={{ flexWrap: 'wrap' }}>
        <Segmented label="Category" value={cat} onChange={setCat} options={[{ value: 'all', label: 'All' }, ...CATS.map(({ value, label }) => ({ value, label }))]} />
        <input className="field" style={{ maxWidth: 240 }} placeholder="Search memory" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search memory" />
      </div>

      {mem.error ? (
        <ErrorNote error={mem.error} retry={mem.reload} />
      ) : !mem.data ? (
        <Skeleton h={64} n={5} />
      ) : items.length === 0 ? (
        <Empty icon="brain" title="Nothing remembered here yet" />
      ) : (
        <div className="stack">
          {items.map((m) => {
            const c = CATS.find((x) => x.value === m.category)!;
            return (
              <div key={m.id} className="mem-item">
                <div className="icon-tile"><Icon name={c.icon} size={16} /></div>
                <div className="body">
                  {editing === m.id ? (
                    <form
                      className="row"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        await patch(m, { content: editText });
                        setEditing(null);
                      }}
                    >
                      <input className="field" style={{ flex: 1 }} autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} aria-label="Edit memory" />
                      <button className="btn btn-sm btn-primary">Save</button>
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : (
                    <p>{m.content}</p>
                  )}
                  <p className="faint">{c.label} · {m.source} · {relTime(m.createdAt)}</p>
                </div>
                <div className="actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => patch(m, { pinned: !m.pinned })} aria-pressed={m.pinned} aria-label={m.pinned ? 'Unpin' : 'Pin'} style={m.pinned ? { color: 'var(--sky)' } : undefined}><Icon name="pin" size={15} /></button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setEditing(m.id); setEditText(m.content); }} aria-label="Edit"><Icon name="edit" size={15} /></button>
                  <button
                    className="btn btn-ghost btn-sm btn-danger"
                    aria-label="Forget"
                    onClick={async () => {
                      await api.deleteMemory(m.id);
                      mem.setData((d) => d && d.filter((x) => x.id !== m.id));
                      toast('Forgotten');
                    }}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
