import { Link, useParams } from 'react-router-dom';
import { Page } from '@/components/layout/Page';
import { projects } from '@/data/projects';
import { Thumb } from '@/components/lists/Thumb';
import styles from './ProjectDetail.module.css';

export default function ProjectDetail() {
  const { id } = useParams();
  const project = projects.find((p) => p.id === id);

  if (!project) {
    return (
      <Page title="Not found">
        <Link to="/projects" className={styles.back}>
          ← Projects
        </Link>
      </Page>
    );
  }

  return (
    <Page title={project.name}>
      <Link to="/projects" className={styles.back}>
        ← Projects
      </Link>
      <p className={styles.tagline}>{project.tagline}</p>

      <div className={styles.meta}>
        {project.year && (
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>Year</span>
            <span>{project.year}</span>
          </div>
        )}
        {project.role && (
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>Role</span>
            <span>{project.role}</span>
          </div>
        )}
      </div>

      <p className={styles.body}>{project.description}</p>

      {project.links && project.links.length > 0 && (
        <div className={styles.links}>
          {project.links.map((l) => (
            <a key={l.url} className={styles.link} href={l.url} target="_blank" rel="noreferrer">
              {l.label} ↗
            </a>
          ))}
        </div>
      )}

      <div className={styles.cover}>
        <Thumb src={project.cover} label={project.name} />
      </div>
    </Page>
  );
}
