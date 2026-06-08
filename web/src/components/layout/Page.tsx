import type { ReactNode } from 'react';
import styles from './Page.module.css';

interface PageProps {
  index?: string;
  title: string;
  intro?: string;
  children: ReactNode;
  /** Full-bleed pages (galleries) skip the container padding. */
  bleed?: boolean;
}

export function Page({ index, title, intro, children, bleed }: PageProps) {
  return (
    <div className={styles.page}>
      <div className={bleed ? undefined : 'container'}>
        <header className={`${bleed ? 'container' : ''} ${styles.header}`.trim()}>
          {index && <span className={styles.index}>{index}</span>}
          <div>
            <h1 className={styles.title}>{title}</h1>
            {intro && <p className={styles.intro}>{intro}</p>}
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
