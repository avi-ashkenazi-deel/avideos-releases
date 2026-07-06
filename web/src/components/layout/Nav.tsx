import { NavLink } from 'react-router-dom';
import styles from './Nav.module.css';

const sectionLinks: [string, string][] = [
  ['Writing', 'writing'],
  ['Talks', 'talks'],
  ['Projects', 'projects'],
  ['About', 'about'],
];

interface NavProps {
  onSection: (id: string) => void;
}

export function Nav({ onSection }: NavProps) {
  return (
    <nav className={styles.nav} aria-label="Primary">
      <button className={styles.wordmark} onClick={() => onSection('top')}>
        Avi Ashkenazi
      </button>
      <div className={styles.links}>
        {sectionLinks.map(([label, id]) => (
          <button key={id} className={styles.link} onClick={() => onSection(id)}>
            {label}
          </button>
        ))}
        <NavLink
          to="/inspiration"
          className={({ isActive }) =>
            isActive ? `${styles.link} ${styles.linkActive}` : styles.link
          }
        >
          Inspiration
        </NavLink>
        <NavLink
          to="/snapshots"
          className={({ isActive }) =>
            isActive ? `${styles.link} ${styles.linkActive}` : styles.link
          }
        >
          Snapshots
        </NavLink>
        {/* Full page-load out of the SPA into the resurrected 2010 portfolio */}
        <a className={styles.link} href={`${import.meta.env.BASE_URL}old/`}>
          Archive
        </a>
      </div>
    </nav>
  );
}
