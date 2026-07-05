import type { GalleryImage } from './types';
import { projectGallery } from './gallery.projects';
import { photography } from './gallery.photography';

// Gallery + Photography merged into one floating field. Deduped by id.
const seen = new Set<string>();
export const snapshots: GalleryImage[] = [...projectGallery, ...photography].filter(
  (img) => {
    if (seen.has(img.id)) return false;
    seen.add(img.id);
    return true;
  },
);
