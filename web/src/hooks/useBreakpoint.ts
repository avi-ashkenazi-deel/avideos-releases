import { useEffect, useState } from 'react';

export type Mode = 'desktop' | 'mobile';

const MOBILE_QUERY = '(max-width: 768px)';

/** Returns 'mobile' below 768px, 'desktop' otherwise. SSR-safe-ish default. */
export function useBreakpoint(): Mode {
  const [mode, setMode] = useState<Mode>(() => {
    if (typeof window === 'undefined') return 'desktop';
    return window.matchMedia(MOBILE_QUERY).matches ? 'mobile' : 'desktop';
  });

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMode(mq.matches ? 'mobile' : 'desktop');
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return mode;
}
