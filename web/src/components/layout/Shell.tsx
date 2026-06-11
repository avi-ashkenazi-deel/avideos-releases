import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Nav } from './Nav';
import { AnimatedRoutes } from './AnimatedRoutes';
import { sections } from '@/sections';
import { useSwipePager } from '@/hooks/useSwipePager';
import styles from './Shell.module.css';

export function DesktopShell() {
  return (
    <div className={styles.desktop}>
      <header className={styles.topbar}>
        <div className="container">
          <Nav />
        </div>
      </header>
      <AnimatedRoutes mode="desktop" />
    </div>
  );
}

/* Native-style bottom tabs: five core destinations. Everything else lives in
 * the full-screen menu. */
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

  // Close the menu whenever navigation happens (links, swipes, back button).
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className={styles.mobile} {...bind()}>
      <header className={styles.mobileTop}>
        <NavLink to="/" className={styles.mobileWordmark} onClick={() => setMenuOpen(false)}>
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
                    onClick={() => setMenuOpen(false)}
                  >
                    <span className={styles.menuIndex}>{s.index}</span>
                    {s.label}
                  </NavLink>
                </motion.li>
              ))}
            </ul>
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
              onClick={() => setMenuOpen(false)}
            >
              {t.label}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
