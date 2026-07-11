import { useNavigate, useParams } from 'react-router-dom';
import type { GalleryProject } from '@/data/snapshots';
import { GalleryCanvas } from './GalleryCanvas';
import styles from './GalleryPage.module.css';

interface GalleryPageProps {
  title: string;
  projects: GalleryProject[];
  basePath: string; // e.g. '/snapshots'
}

export function GalleryPage({ title, projects, basePath }: GalleryPageProps) {
  const { id } = useParams();
  const navigate = useNavigate();

  return (
    <div className={styles.screen}>
      <div className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
      </div>
      <GalleryCanvas
        projects={projects}
        activeId={id}
        onOpen={(p) => navigate(`${basePath}/${p.id}`)}
        onClose={() => navigate(basePath)}
      />
    </div>
  );
}
