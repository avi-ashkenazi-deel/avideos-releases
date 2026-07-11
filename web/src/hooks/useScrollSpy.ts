import { useEffect } from 'react';

/**
 * Reflects the section currently in view into the URL hash (via replaceState,
 * so it doesn't trigger router navigation). Also scrolls to the hash on mount.
 */
export function useScrollSpy(ids: string[]) {
  useEffect(() => {
    // scroll to an incoming hash on first render
    const initial = window.location.hash.replace('#', '');
    if (initial) {
      requestAnimationFrame(() =>
        document.getElementById(initial)?.scrollIntoView({ block: 'start' }),
      );
    }

    let current = '';
    const setHash = (id: string) => {
      const hash = id === 'top' ? '' : `#${id}`;
      if (hash === (id === 'top' ? '' : window.location.hash)) return;
      if (id === current) return;
      current = id;
      history.replaceState(null, '', window.location.pathname + window.location.search + hash);
    };

    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setHash(visible[0].target.id);
      },
      // a thin band around the upper-middle of the viewport marks "current"
      { rootMargin: '-40% 0px -55% 0px', threshold: 0 },
    );

    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, [ids]);
}
