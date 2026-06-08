import { GalleryPage } from '@/components/gallery/GalleryPage';
import { photography } from '@/data/gallery.photography';

export default function Photography() {
  return (
    <GalleryPage
      index="06"
      title="Photography"
      items={photography}
      basePath="/photography"
    />
  );
}
