import { Link } from 'react-router-dom';
import { projects } from '@/data/projects';
import { Thumb } from '@/components/lists/Thumb';
import styles from '@/components/lists/Lists.module.css';

export function ProjectsBody() {
  return (
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
  );
}
