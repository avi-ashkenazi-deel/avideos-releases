import { GalleryPage } from '@/components/gallery/GalleryPage';
import { projectsGallery } from '@/data/snapshots';

export default function Snapshots() {
  return <GalleryPage title="Snapshots" projects={projectsGallery} basePath="/snapshots" />;
}
