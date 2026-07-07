import { useEffect, useState } from 'react';

/**
 * When the page is scrolled to the very bottom and the user keeps pulling
 * (wheel or touch), fills a progress value 0→1 and fires `onTrigger` once it
 * completes — like the "pull for next" at the end of a Telegram/TechCrunch post.
 */
export function usePullToNext(enabled: boolean, onTrigger: () => void): number {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const THRESH = 520;
    let acc = 0;
    let fired = false;
    let touchY: number | null = null;
    let resetTimer: number | undefined;

    const atBottom = () =>
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;

    const scheduleReset = () => {
      window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => {
        if (!fired) {
          acc = 0;
          setProgress(0);
        }
      }, 220);
    };

    const bump = (d: number) => {
      if (fired) return;
      if (!atBottom()) {
        acc = 0;
        setProgress(0);
        return;
      }
      acc = Math.max(0, acc + d);
      const p = Math.min(1, acc / THRESH);
      setProgress(p);
      scheduleReset();
      if (p >= 1) {
        fired = true;
        setProgress(1);
        onTrigger();
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY > 0) bump(e.deltaY);
    };
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchY == null) return;
      const y = e.touches[0]?.clientY ?? touchY;
      const dy = touchY - y; // pulling up = positive
      touchY = y;
      if (dy > 0) bump(dy * 2.4);
    };
    const onTouchEnd = () => {
      touchY = null;
      if (!fired) {
        acc = 0;
        setProgress(0);
      }
    };

    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      window.clearTimeout(resetTimer);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [enabled, onTrigger]);

  return progress;
}
