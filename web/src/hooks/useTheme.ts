import { useCallback, useEffect, useState } from 'react';

export type Theme = 'auto' | 'light' | 'dark';

export function useTheme(): { theme: Theme; cycle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem('theme');
      return t === 'light' || t === 'dark' ? t : 'auto';
    } catch {
      return 'auto';
    }
  });

  useEffect(() => {
    const el = document.documentElement;
    try {
      if (theme === 'auto') {
        el.removeAttribute('data-theme');
        localStorage.removeItem('theme');
      } else {
        el.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
      }
    } catch {
      /* ignore */
    }
  }, [theme]);

  const cycle = useCallback(
    () => setTheme((t) => (t === 'auto' ? 'light' : t === 'light' ? 'dark' : 'auto')),
    [],
  );

  return { theme, cycle };
}
