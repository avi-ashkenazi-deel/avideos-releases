import { useNavigate, useParams } from 'react-router-dom';
import type { GalleryImage } from '@/data/types';
import { GalleryCanvas } from './GalleryCanvas';
import styles from './GalleryPage.module.css';

interface GalleryPageProps {
  index: string;
  title: string;
  items: GalleryImage[];
  basePath: string; // e.g. '/photography'
}

export function GalleryPage({ index, title, items, basePath }: GalleryPageProps) {
  const { id } = useParams();
  const navigate = useNavigate();

  return (
    <div className={styles.screen}>
      <div className={styles.header}>
        <span className={styles.index}>{index}</span>
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
