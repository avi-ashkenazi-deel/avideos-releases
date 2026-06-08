import { Suspense } from 'react';
import { Link } from 'react-router-dom';
import { HeroCanvas } from '@/components/hero/HeroCanvas';
import { about } from '@/data/about';
import { sections } from '@/sections';
import styles from './Home.module.css';

export default function Home() {
  const quickLinks = sections.filter((s) =>
    ['/writing', '/projects', '/gallery', '/about'].includes(s.path),
  );

  return (
    <div className={styles.home}>
      <div className={styles.canvas}>
        <Suspense fallback={null}>
          <HeroCanvas />
        </Suspense>
      </div>
      <div className={styles.content}>
        <h1 className={styles.name}>{about.name}</h1>
        <p className={styles.bio}>{about.bio}</p>
        <nav className={styles.enter} aria-label="Quick links">
          {quickLinks.map((s) => (
            <Link key={s.path} to={s.path} className={styles.enterLink}>
              {s.label} ↗
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
