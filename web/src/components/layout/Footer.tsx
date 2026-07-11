import { socials } from '@/data/socials';
import styles from './Footer.module.css';

export function Footer() {
  return (
    <footer className={styles.footer}>
      <span className={styles.label}>Elsewhere</span>
      <nav className={styles.links} aria-label="Social links">
        {socials.map((s) => (
          <a key={s.id} className={styles.link} href={s.url} target="_blank" rel="noreferrer">
            {s.label}
          </a>
        ))}
      </nav>
      <span className={styles.colophon}>© {new Date().getFullYear()} Avi Ashkenazi</span>
    </footer>
  );
}
