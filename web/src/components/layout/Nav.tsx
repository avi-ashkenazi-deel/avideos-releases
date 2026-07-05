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
          to="/gallery"
          className={({ isActive }) =>
            isActive ? `${styles.link} ${styles.linkActive}` : styles.link
          }
        >
          Gallery
        </NavLink>
        <NavLink
          to="/photography"
          className={({ isActive }) =>
            isActive ? `${styles.link} ${styles.linkActive}` : styles.link
          }
        >
          Photography
        </NavLink>
      </div>
    </nav>
  );
}
