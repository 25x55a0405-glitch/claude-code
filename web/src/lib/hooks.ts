import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type LiveEvent, type LiveEventType } from '../api';

/** Load data from the API and reload when any of the given live events arrive. */
export function useResource<T>(load: () => Promise<T>, deps: unknown[], reloadOn: LiveEventType[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(() => {
    loadRef.current().then(
      (d) => { setData(d); setError(null); },
      (e: Error) => setError(e),
    );
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, deps);

  const key = reloadOn.join('|');
  useEffect(() => {
    if (!key) return;
    const types = new Set(key.split('|'));
    return api.subscribe((e) => { if (types.has(e.type)) reload(); });
  }, [key, reload]);

  return { data, error, reload, setData };
}

/** Run a handler for every live event. */
export function useLiveEvents(handler: (e: LiveEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => api.subscribe((e) => ref.current(e)), []);
}
