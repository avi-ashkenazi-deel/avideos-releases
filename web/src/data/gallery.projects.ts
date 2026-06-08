import type { GalleryImage } from './types';

/*
 * Project gallery — selected work, floating in an infinite field.
 * Same placeholder behaviour as the photography gallery: set `src` to a real
 * file under /public/images/projects/ to swap in artwork.
 */
export const projectGallery: GalleryImage[] = [
  { id: 'g01', src: '', width: 1600, height: 1000, title: 'Vidit', description: 'Cinematic video editor — timeline study.', projectId: 'vidit' },
  { id: 'g02', src: '', width: 1280, height: 1600, title: 'Vidit', description: 'Mobile editing flow.', projectId: 'vidit' },
  { id: 'g03', src: '', width: 1600, height: 1066, title: 'Links', description: 'Second brain — graph view.', projectId: 'links' },
  { id: 'g04', src: '', width: 1400, height: 1400, title: 'Links', description: 'Capture surface.', projectId: 'links' },
  { id: 'g05', src: '', width: 1600, height: 900, title: 'Samsung', description: 'Visual display interaction concept.' },
  { id: 'g06', src: '', width: 1200, height: 1500, title: 'iwoca', description: 'Lending product flow.' },
  { id: 'g07', src: '', width: 1600, height: 1066, title: 'Shopify', description: 'Internationalization.' },
  { id: 'g08', src: '', width: 1500, height: 1000, title: 'Deel', description: 'AI & fintech surfaces.' },
  { id: 'g09', src: '', width: 1080, height: 1350, title: 'MusicTechFest', description: 'Festival identity.' },
];
