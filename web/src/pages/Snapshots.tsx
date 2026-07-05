import { GalleryPage } from '@/components/gallery/GalleryPage';
import { snapshots } from '@/data/snapshots';

export default function Snapshots() {
  return <GalleryPage title="Snapshots" items={snapshots} basePath="/snapshots" />;
}
