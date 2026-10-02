import type { ServerEvent } from './types.ts';

type Handler = (e: ServerEvent) => void;

/** Fan-out of live events to every open event stream. */
export class EventBus {
  private handlers = new Set<Handler>();

  emit(event: ServerEvent) {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        console.error('[events] handler failed', err);
      }
    }
  }

  subscribe(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  get size() {
    return this.handlers.size;
  }
}
