import { Link } from 'react-router-dom';
import { Page } from '@/components/layout/Page';
import { projects } from '@/data/projects';
import { Thumb } from '@/components/lists/Thumb';
import styles from '@/components/lists/Lists.module.css';

export default function Projects() {
  return (
    <Page index="03" title="Projects" intro="Selected work, with a little more detail.">
      <div className={styles.grid}>
        {projects.map((p) => (
          <Link key={p.id} className={styles.card} to={`/projects/${p.id}`}>
            <div className={styles.thumb}>
              <Thumb src={p.cover} label={p.name} />
            </div>
            <div className={styles.cardName}>{p.name}</div>
            <div className={styles.cardBlurb}>{p.tagline}</div>
          </Link>
        ))}
      </div>
    </Page>
  );
}
