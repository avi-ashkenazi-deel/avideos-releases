import { NavLink } from 'react-router-dom';
import { sections } from '@/sections';
import styles from './Nav.module.css';

export function Nav() {
  return (
    <nav className={styles.nav} aria-label="Primary">
      <NavLink to="/" className={styles.wordmark}>
        Avi Ashkenazi
      </NavLink>
      <div className={styles.links}>
        {sections
          .filter((s) => s.path !== '/')
          .map((s) => (
            <NavLink
              key={s.path}
              to={s.path}
              className={({ isActive }) =>
                isActive ? `${styles.link} ${styles.active}` : styles.link
              }
            >
              {s.label}
            </NavLink>
          ))}
      </div>
    </nav>
  );
}
