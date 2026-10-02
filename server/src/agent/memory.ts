import type { MemoryItem } from '../types.ts';

const STOP = new Set('the a an and or of to in on for with at by from is are be my me i you it this that what when how about please can could would'.split(' '));
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.filter((w) => !STOP.has(w)) ?? [];

/** Memories most related to some text, by word overlap. Pinned ones are added separately. */
export function relevantMemory(items: MemoryItem[], text: string, limit = 12): MemoryItem[] {
  const q = new Set(words(text));
  if (!q.size) return [];
  return items
    .map((m) => ({ m, score: words(m.content).filter((w) => q.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
}

/** What goes into the agent's context: every pinned memory plus the most relevant and most recent. */
export function contextMemory(items: MemoryItem[], text: string): MemoryItem[] {
  const out = new Map<string, MemoryItem>();
  for (const m of items) if (m.pinned) out.set(m.id, m);
  for (const m of relevantMemory(items, text)) out.set(m.id, m);
  for (const m of items.slice(0, 15)) out.set(m.id, m);
  return [...out.values()];
}
