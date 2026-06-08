import { useMemo, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { useDrag } from '@use-gesture/react';
import * as THREE from 'three';
import type { GalleryImage } from '@/data/types';
import { InfiniteField } from './InfiniteField';
import { GalleryDetail } from './GalleryDetail';
import styles from './Gallery.module.css';

interface GalleryCanvasProps {
  items: GalleryImage[];
  activeId?: string;
  onOpen: (item: GalleryImage) => void;
  onClose: () => void;
}

export function GalleryCanvas({ items, activeId, onOpen, onClose }: GalleryCanvasProps) {
  const offset = useRef(new THREE.Vector2(0, 0));
  const offsetTarget = useRef(new THREE.Vector2(0, 0));
  const worldPerPixel = useRef(0.01);
  const dragStart = useRef(new THREE.Vector2(0, 0));
  const draggedRef = useRef(false);

  const activeIndex = useMemo(() => {
    if (!activeId) return null;
    const i = items.findIndex((it) => it.id === activeId);
    return i === -1 ? null : i;
  }, [activeId, items]);

  // Latest activeIndex for the drag handler (avoids stale closures).
  const activeRef = useRef<number | null>(activeIndex);
  activeRef.current = activeIndex;

  const bind = useDrag(
    ({ first, last, movement: [mx, my] }) => {
      if (activeRef.current !== null) return; // no panning while zoomed
      if (first) {
        dragStart.current.copy(offsetTarget.current);
        draggedRef.current = false;
      }
      const wpp = worldPerPixel.current;
      offsetTarget.current.set(
        dragStart.current.x + mx * wpp,
        dragStart.current.y - my * wpp,
      );
      if (Math.hypot(mx, my) > 6) draggedRef.current = true;
      if (last) {
        // let the click handler (fires after pointerup) read draggedRef first
        window.setTimeout(() => {
          draggedRef.current = false;
        }, 60);
      }
    },
    { filterTaps: true },
  );

  const go = (dir: number) => {
    if (activeIndex === null) return;
    const next = (activeIndex + dir + items.length) % items.length;
    onOpen(items[next]);
  };

  const activeItem = activeIndex !== null ? items[activeIndex] : null;

  return (
    <div className={styles.wrap} {...bind()}>
      <Canvas
        camera={{ position: [0, 0, 12], fov: 45 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
        onPointerMissed={() => {
          if (activeRef.current !== null && !draggedRef.current) onClose();
        }}
      >
        <InfiniteField
          items={items}
          offset={offset}
          offsetTarget={offsetTarget}
          worldPerPixel={worldPerPixel}
          activeIndex={activeIndex}
          onSelect={(i) => onOpen(items[i])}
          draggedRef={draggedRef}
        />
      </Canvas>

      {activeItem === null && <div className={styles.hint}>Drag to explore · Click to open</div>}

      <GalleryDetail
        item={activeItem}
        onClose={onClose}
        onPrev={() => go(-1)}
        onNext={() => go(1)}
      />
    </div>
  );
}
