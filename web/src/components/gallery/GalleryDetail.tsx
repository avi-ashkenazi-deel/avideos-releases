import { AnimatePresence, motion } from 'framer-motion';
import type { GalleryImage } from '@/data/types';
import styles from './Gallery.module.css';

interface GalleryDetailProps {
  item: GalleryImage | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}

export function GalleryDetail({ item, onClose, onPrev, onNext }: GalleryDetailProps) {
  return (
    <AnimatePresence>
      {item && (
        <>
          <div className={styles.controls}>
            <button className={styles.ctrl} onClick={onClose}>
              Close
            </button>
          </div>

          <motion.div
            className={styles.detail}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className={styles.detailText}>
              {item.title && <div className={styles.detailTitle}>{item.title}</div>}
              {item.description && (
                <p className={styles.detailDesc}>{item.description}</p>
              )}
            </div>
          </motion.div>

          <div className={styles.nav}>
            <button className={styles.ctrl} onClick={onPrev} aria-label="Previous">
              Prev
            </button>
            <button className={styles.ctrl} onClick={onNext} aria-label="Next">
              Next
            </button>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
