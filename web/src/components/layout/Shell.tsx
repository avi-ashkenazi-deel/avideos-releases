import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Nav } from './Nav';
import { AnimatedRoutes } from './AnimatedRoutes';
import { sections, sectionIndex } from '@/sections';
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

export function MobileShell() {
  const bind = useSwipePager();
  const location = useLocation();
  const activeIdx = sectionIndex(location.pathname);
  const barRef = useRef<HTMLElement>(null);

  // Keep the active section chip in view in the bottom bar.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const el = bar.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [activeIdx]);

  return (
    <div className={styles.mobile} {...bind()}>
      <AnimatedRoutes mode="mobile" />
      <nav className={styles.mobileBar} ref={barRef} aria-label="Sections">
        {sections.map((s) => (
          <NavLink
            key={s.path}
            to={s.path}
            end={s.path === '/'}
            className={({ isActive }) =>
              isActive
                ? `${styles.mobileLink} ${styles.mobileLinkActive}`
                : styles.mobileLink
            }
          >
            {s.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
