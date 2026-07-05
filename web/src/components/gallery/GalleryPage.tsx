import { useNavigate, useParams } from 'react-router-dom';
import type { GalleryImage } from '@/data/types';
import { GalleryCanvas } from './GalleryCanvas';
import styles from './GalleryPage.module.css';

interface GalleryPageProps {
  title: string;
  items: GalleryImage[];
  basePath: string; // e.g. '/snapshots'
}

export function GalleryPage({ title, items, basePath }: GalleryPageProps) {
  const { id } = useParams();
  const navigate = useNavigate();

  return (
    <div className={styles.screen}>
      <div className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
      </div>
      <GalleryCanvas
        items={items}
        activeId={id}
        onOpen={(item) => navigate(`${basePath}/${item.id}`)}
        onClose={() => navigate(basePath)}
      />
    </div>
  );
}
