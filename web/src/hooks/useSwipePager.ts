import { useNavigate, useLocation } from 'react-router-dom';
import { useDrag } from '@use-gesture/react';
import { sections, sectionIndex } from '@/sections';

/**
 * Horizontal swipe to paginate between sibling sections on mobile.
 * Disabled on gallery routes (they own the drag gesture). Vertical scroll is
 * preserved because the drag is axis-locked to x (touch-action: pan-y).
 */
export function useSwipePager() {
  const navigate = useNavigate();
  const location = useLocation();
  const disabled = /^\/(gallery|photography)/.test(location.pathname);

  return useDrag(
    ({ last, movement: [mx], velocity: [vx], direction: [dx] }) => {
      if (disabled || !last) return;
      const passed = Math.abs(mx) > 80 || vx > 0.4;
      if (!passed) return;
      const idx = sectionIndex(location.pathname);
      if (dx < 0) {
        const n = Math.min(sections.length - 1, idx + 1);
        if (n !== idx) navigate(sections[n].path);
      } else if (dx > 0) {
        const p = Math.max(0, idx - 1);
        if (p !== idx) navigate(sections[p].path);
      }
    },
    { axis: 'x', filterTaps: true },
  );
}
