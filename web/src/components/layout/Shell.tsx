import { lazy, Suspense, useEffect, useState } from 'react';
import {
  NavLink,
  useLocation,
  useNavigate,
  useRoutes,
} from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { AnimatedRoutes } from './AnimatedRoutes';
import { Footer } from './Footer';
import { sections } from '@/sections';
import { useSwipePager } from '@/hooks/useSwipePager';
import styles from './Shell.module.css';

const DesktopHome = lazy(() => import('@/pages/DesktopHome'));
const Gallery = lazy(() => import('@/pages/Gallery'));
const Photography = lazy(() => import('@/pages/Photography'));
const ProjectDetail = lazy(() => import('@/pages/ProjectDetail'));

/* ------------------------------- Desktop ------------------------------- */

// In-page sections (scroll anchors) vs. routed overlays (galleries).
const sectionLinks: [string, string][] = [
  ['Writing', 'writing'],
  ['Talks', 'talks'],
  ['Projects', 'projects'],
  ['Tools', 'tools'],
  ['About', 'about'],
];

export function DesktopShell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const isGallery = /^\/(gallery|photography)/.test(pathname);
  const isDetail = /^\/projects\/.+/.test(pathname);
  const overlayOpen = isGallery || isDetail;

  // Routes that render as a full overlay above the scrolling page.
  const overlay = useRoutes([
    { path: '/gallery', element: <Gallery /> },
    { path: '/gallery/:id', element: <Gallery /> },
    { path: '/photography', element: <Photography /> },
    { path: '/photography/:id', element: <Photography /> },
    { path: '/projects/:id', element: <ProjectDetail /> },
  ]);

  const scrollToId = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const goSection = (id: string) => {
    if (overlayOpen) {
      navigate('/');
      // wait for the overlay to unmount before scrolling
      requestAnimationFrame(() => requestAnimationFrame(() => scrollToId(id)));
    } else {
      scrollToId(id);
    }
  };

  return (
    <div className={styles.desktop}>
      <header className={styles.topbar}>
        <div className={`container ${styles.nav}`}>
          <button className={styles.wordmark} onClick={() => goSection('top')}>
            Avi Ashkenazi
          </button>
          <div className={styles.navLinks}>
            {sectionLinks.map(([label, id]) => (
              <button key={id} className={styles.navLink} onClick={() => goSection(id)}>
                {label}
              </button>
            ))}
            <NavLink
              to="/gallery"
              className={({ isActive }) =>
                isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink
              }
            >
              Gallery
            </NavLink>
            <NavLink
              to="/photography"
              className={({ isActive }) =>
                isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink
              }
            >
              Photography
            </NavLink>
          </div>
        </div>
      </header>

      <div className={styles.body}>
        <main className={styles.scroller}>
          <Suspense fallback={null}>
            <DesktopHome />
          </Suspense>
        </main>

        <AnimatePresence>
          {overlayOpen && (
            <motion.div
              key={pathname.split('/')[1]}
              className={styles.overlay}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } }}
              exit={{ opacity: 0, y: 24, transition: { duration: 0.25 } }}
            >
              <Suspense fallback={null}>{overlay}</Suspense>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* -------------------------------- Mobile -------------------------------- */

const tabs = [
  { path: '/', label: 'Index' },
  { path: '/writing', label: 'Writing' },
  { path: '/projects', label: 'Work' },
  { path: '/gallery', label: 'Gallery' },
  { path: '/about', label: 'About' },
];

function matchesTab(pathname: string, tabPath: string): boolean {
  if (tabPath === '/') return pathname === '/';
  return pathname === tabPath || pathname.startsWith(tabPath + '/');
}

export function MobileShell() {
  const bind = useSwipePager();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className={styles.mobile} {...bind()}>
      <header className={styles.mobileTop}>
        <NavLink to="/" className={styles.mobileWordmark}>
          Avi Ashkenazi
        </NavLink>
        <button
          className={styles.menuButton}
          onClick={() => setMenuOpen((o) => !o)}
          aria-expanded={menuOpen}
        >
          {menuOpen ? 'Close' : 'Menu'}
        </button>
      </header>

      <AnimatedRoutes mode="mobile" />

      <AnimatePresence>
        {menuOpen && (
          <motion.nav
            className={styles.menu}
            aria-label="All sections"
            initial={{ y: '100%' }}
            animate={{ y: 0, transition: { type: 'spring', stiffness: 340, damping: 36 } }}
            exit={{ y: '100%', transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] } }}
          >
            <div className={styles.menuInner}>
              <ul className={styles.menuList}>
                {sections.map((s, i) => (
                  <motion.li
                    key={s.path}
                    initial={{ opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0, transition: { delay: 0.06 + i * 0.035 } }}
                  >
                    <NavLink
                      to={s.path}
                      end={s.path === '/'}
                      className={({ isActive }) =>
                        isActive ? `${styles.menuLink} ${styles.menuLinkActive}` : styles.menuLink
                      }
                    >
                      <span className={styles.menuIndex}>{s.index}</span>
                      {s.label}
                    </NavLink>
                  </motion.li>
                ))}
              </ul>
              <Footer />
            </div>
          </motion.nav>
        )}
      </AnimatePresence>

      <nav className={styles.tabbar} aria-label="Primary">
        {tabs.map((t) => {
          const active = !menuOpen && matchesTab(location.pathname, t.path);
          return (
            <NavLink
              key={t.path}
              to={t.path}
              className={active ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            >
              {t.label}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
