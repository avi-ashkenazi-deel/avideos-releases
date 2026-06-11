import { Suspense } from 'react';
import { useLocation, useRoutes } from 'react-router-dom';
import { AnimatePresence, motion, type Variants } from 'framer-motion';
import { routes } from '@/routes';
import type { Mode } from '@/hooks/useBreakpoint';
import styles from './AnimatedRoutes.module.css';

const desktopVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  enter: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.2 } },
};

/*
 * iOS-modal feel: the incoming view rises from the bottom as a sheet with
 * rounded top corners that settle flat; the outgoing view stays put, scaling
 * back and dimming underneath it.
 */
const mobileVariants: Variants = {
  initial: {
    y: '100%',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    boxShadow: '0 -12px 48px rgba(0,0,0,0.18)',
  },
  enter: {
    y: 0,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    boxShadow: '0 -12px 48px rgba(0,0,0,0)',
    transition: {
      y: { type: 'spring', stiffness: 360, damping: 38, mass: 0.9 },
      borderTopLeftRadius: { delay: 0.28, duration: 0.25 },
      borderTopRightRadius: { delay: 0.28, duration: 0.25 },
      boxShadow: { delay: 0.28, duration: 0.25 },
    },
  },
  exit: {
    scale: 0.94,
    opacity: 0.5,
    transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] },
  },
};

function sectionKey(pathname: string): string {
  return '/' + (pathname.split('/')[1] ?? '');
}

export function AnimatedRoutes({ mode }: { mode: Mode }) {
  const location = useLocation();
  const element = useRoutes(routes, location);
  const key = sectionKey(location.pathname);
  const isMobile = mode === 'mobile';

  return (
    <div className={styles.viewport}>
      <AnimatePresence mode={isMobile ? 'popLayout' : 'wait'} initial={false}>
        <motion.div
          key={key}
          className={`${styles.layer} ${isMobile ? styles.layerMobile : ''}`}
          variants={isMobile ? mobileVariants : desktopVariants}
          initial="initial"
          animate="enter"
          exit="exit"
        >
          <Suspense fallback={<div className={styles.loading}>Loading</div>}>
            {element}
          </Suspense>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
