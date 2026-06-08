import { GalleryPage } from '@/components/gallery/GalleryPage';
import { projectGallery } from '@/data/gallery.projects';

export default function Gallery() {
  return (
    <GalleryPage
      index="05"
      title="Gallery"
      items={projectGallery}
      basePath="/gallery"
    />
  );
}
