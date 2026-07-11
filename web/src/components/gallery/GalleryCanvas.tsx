import { useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { useDrag } from '@use-gesture/react';
import * as THREE from 'three';
import type { GalleryProject } from '@/data/snapshots';
import { InfiniteField } from './InfiniteField';
import { ProjectViewer } from './ProjectViewer';
import styles from './Gallery.module.css';

interface GalleryCanvasProps {
  projects: GalleryProject[];
  activeId?: string;
  onOpen: (project: GalleryProject) => void;
  onClose: () => void;
}

export function GalleryCanvas({ projects, activeId, onOpen, onClose }: GalleryCanvasProps) {
  const offset = useRef(new THREE.Vector2(0, 0));
  const offsetTarget = useRef(new THREE.Vector2(0, 0));
  const worldPerPixel = useRef(0.01);
  const dragStart = useRef(new THREE.Vector2(0, 0));
  const draggedRef = useRef(false);
  const [density, setDensity] = useState(1);

  // one representative image per project for the floating field
  const fieldItems = useMemo(() => projects.map((p) => p.images[0]), [projects]);

  const activeIndex = useMemo(() => {
    if (!activeId) return null;
    const i = projects.findIndex((p) => p.id === activeId);
    return i === -1 ? null : i;
  }, [activeId, projects]);
  const activeRef = useRef<number | null>(activeIndex);
  activeRef.current = activeIndex;

  const bind = useDrag(
    ({ first, last, movement: [mx, my] }) => {
      if (activeRef.current !== null) return;
      if (first) {
        dragStart.current.copy(offsetTarget.current);
        draggedRef.current = false;
      }
      const wpp = worldPerPixel.current;
      offsetTarget.current.set(dragStart.current.x + mx * wpp, dragStart.current.y - my * wpp);
      if (Math.hypot(mx, my) > 6) draggedRef.current = true;
      if (last) window.setTimeout(() => (draggedRef.current = false), 60);
    },
    { filterTaps: true },
  );

  const activeProject = activeIndex !== null ? projects[activeIndex] : null;
  const stepProject = (dir: number) => {
    const base = activeIndex ?? 0;
    const next = (base + dir + projects.length) % projects.length;
    onOpen(projects[next]);
  };

  return (
    <div className={styles.wrap} {...bind()}>
      <Canvas
        camera={{ position: [0, 0, 12], fov: 45 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
      >
        <InfiniteField
          items={fieldItems}
          offset={offset}
          offsetTarget={offsetTarget}
          worldPerPixel={worldPerPixel}
          anyActive={activeIndex !== null}
          onSelect={(i) => onOpen(projects[i])}
          draggedRef={draggedRef}
          density={density}
        />
      </Canvas>

      {activeProject === null && (
        <>
          <div className={styles.hint}>Drag to explore · Click to open</div>
          <div className={styles.density}>
            <span>Sparse</span>
            <input
              type="range"
              min={0.6}
              max={1.7}
              step={0.05}
              value={density}
              onChange={(e) => setDensity(Number(e.target.value))}
              aria-label="Density"
            />
            <span>Dense</span>
          </div>
        </>
      )}

      <ProjectViewer project={activeProject} onClose={onClose} onAdjacentProject={stepProject} />
    </div>
  );
}
