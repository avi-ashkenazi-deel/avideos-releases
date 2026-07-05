import { projects } from '@/data/projects';
import { Thumb } from '@/components/lists/Thumb';
import styles from '@/components/lists/Lists.module.css';

export function ProjectsBody() {
  return (
    <div className={styles.projects}>
      {projects.map((p, i) => (
        <article key={p.id} className={styles.project}>
          <span className={styles.projectIndex}>
            {String(i + 1).padStart(2, '0')}
          </span>
          <h3 className={styles.projectName}>{p.name}</h3>
          <div className={styles.projectBody}>
            <p className={styles.projectTagline}>{p.tagline}</p>
            <p className={styles.projectDesc}>{p.description}</p>
            {p.links?.[0] && p.links[0].url !== '#' && (
              <a
                className={styles.projectLink}
                href={p.links[0].url}
                target="_blank"
                rel="noreferrer"
              >
                {p.links[0].label}
              </a>
            )}
          </div>
          <div className={styles.projectThumb}>
            <Thumb src={p.cover} label={p.name} />
          </div>
        </article>
      ))}
    </div>
  );
}
