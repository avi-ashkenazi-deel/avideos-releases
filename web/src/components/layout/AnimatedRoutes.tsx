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

const mobileVariants: Variants = {
  initial: { y: '100%' },
  enter: {
    y: 0,
    transition: { type: 'spring', stiffness: 320, damping: 36, mass: 0.9 },
  },
  exit: {
    y: '8%',
    opacity: 0.4,
    scale: 0.96,
    transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] },
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
