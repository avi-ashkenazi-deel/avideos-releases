import { NavLink } from 'react-router-dom';
import { useTheme } from '@/hooks/useTheme';
import styles from './Nav.module.css';

const THEME_LABEL: Record<string, string> = { auto: 'Auto', light: 'Light', dark: 'Dark' };

const sectionLinks: [string, string][] = [
  ['Talks', 'talks'],
  ['Projects', 'projects'],
  ['Writing', 'writing'],
  ['About', 'about'],
];

interface NavProps {
  onSection: (id: string) => void;
}

export function Nav({ onSection }: NavProps) {
  const { theme, cycle } = useTheme();
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
        <button
          className={styles.link}
          onClick={cycle}
          aria-label={`Theme: ${THEME_LABEL[theme]}`}
          title="Toggle theme"
        >
          {THEME_LABEL[theme]}
        </button>
      </div>
    </nav>
  );
}
