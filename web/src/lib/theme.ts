import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'sky.theme';

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch { /* storage unavailable */ }
  return 'system';
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(read);
  useEffect(() => {
    const root = document.documentElement;
    if (pref === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', pref);
    try { localStorage.setItem(KEY, pref); } catch { /* ignore */ }
  }, [pref]);
  return [pref, setPref] as const;
}
