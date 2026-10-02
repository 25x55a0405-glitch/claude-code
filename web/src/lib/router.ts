import { useEffect, useState } from 'react';

/** Minimal hash router: "#/tasks/t_1" → ["tasks", "t_1"]. */
export function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => { setRoute(read()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const href = (...parts: string[]) => '#/' + parts.join('/');
export const navigate = (...parts: string[]) => { window.location.hash = href(...parts); };
