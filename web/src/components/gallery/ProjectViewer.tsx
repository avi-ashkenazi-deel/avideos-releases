import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion, type Variants } from 'framer-motion';
import type { GalleryProject } from '@/data/snapshots';
import { asset } from '@/lib/asset';
import styles from './ProjectViewer.module.css';

const slideVariants: Variants = {
  enter: (d: number) => ({ x: d >= 0 ? '6%' : '-6%', opacity: 0 }),
  center: { x: 0, opacity: 1, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
  exit: (d: number) => ({ x: d >= 0 ? '-4%' : '4%', opacity: 0, transition: { duration: 0.25 } }),
};

interface ProjectViewerProps {
  project: GalleryProject | null;
  onClose: () => void;
  onAdjacentProject?: (dir: number) => void; // step to prev/next project at the ends
}

export function ProjectViewer({ project, onClose, onAdjacentProject }: ProjectViewerProps) {
  const [[index, dir], setIndex] = useState<[number, number]>([0, 0]);

  // reset to first image whenever the project changes
  useEffect(() => {
    setIndex([0, 0]);
  }, [project?.id]);

  const total = project?.images.length ?? 0;

  const go = useCallback(
    (delta: number) => {
      if (!project) return;
      const next = index + delta;
      if (next < 0 || next >= total) {
        onAdjacentProject?.(delta); // hop to neighbouring project
        return;
      }
      setIndex([next, delta]);
    },
    [project, index, total, onAdjacentProject],
  );

  useEffect(() => {
    if (!project) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, go, onClose]);

  return (
    <AnimatePresence>
      {project && (
        <motion.div
          className={styles.overlay}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.28 } }}
          exit={{ opacity: 0, transition: { duration: 0.2 } }}
        >
          <div className={styles.bar}>
            <div>
              <span className={styles.title}>{project.title}</span>
              {project.description && <span className={styles.desc}>{project.description}</span>}
            </div>
            <button className={styles.close} onClick={onClose}>
              Close
            </button>
          </div>

          <div className={styles.stage}>
            <button className={`${styles.zone} ${styles.zoneL}`} onClick={() => go(-1)} aria-label="Previous" />
            <button className={`${styles.zone} ${styles.zoneR}`} onClick={() => go(1)} aria-label="Next" />
            <AnimatePresence custom={dir} mode="popLayout">
              <motion.div
                key={index}
                className={styles.slide}
                custom={dir}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
              >
                {project.images[index] && (
                  <img src={asset(project.images[index].src)} alt={`${project.title} ${index + 1}`} />
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className={styles.foot}>
            <button className={styles.nav} onClick={() => go(-1)}>
              Prev
            </button>
            <span className={styles.counter}>
              {index + 1} / {total}
            </span>
            <input
              className={styles.scrub}
              type="range"
              min={0}
              max={Math.max(0, total - 1)}
              value={index}
              onChange={(e) => {
                const v = Number(e.target.value);
                setIndex([v, v > index ? 1 : -1]);
              }}
              aria-label="Scrub images"
            />
            <button className={styles.nav} onClick={() => go(1)}>
              Next
            </button>
            <span className={styles.hint}>← → to navigate</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
