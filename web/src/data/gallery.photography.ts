import type { GalleryImage } from './types';

/*
 * Photography gallery — images floating in an infinite field.
 * `src` is intentionally empty for now: the gallery renders a tasteful
 * procedural placeholder per item. Drop a real file in /public/images/photography/
 * and set `src` (e.g. '/images/photography/01.jpg') to swap it in.
 * `width`/`height` set the aspect ratio of the floating plane.
 */
export const photography: GalleryImage[] = [
  { id: 'p01', src: '', width: 1600, height: 1066, title: 'Untitled 01', description: 'London, on film.' },
  { id: 'p02', src: '', width: 1066, height: 1600, title: 'Untitled 02', description: 'A vertical study.' },
  { id: 'p03', src: '', width: 1600, height: 1600, title: 'Untitled 03', description: 'Square frame.' },
  { id: 'p04', src: '', width: 1600, height: 900, title: 'Untitled 04', description: 'Wide horizon.' },
  { id: 'p05', src: '', width: 1200, height: 1500, title: 'Untitled 05', description: 'Portrait.' },
  { id: 'p06', src: '', width: 1600, height: 1066, title: 'Untitled 06', description: 'Street.' },
  { id: 'p07', src: '', width: 1066, height: 1600, title: 'Untitled 07', description: 'Architecture.' },
  { id: 'p08', src: '', width: 1500, height: 1000, title: 'Untitled 08', description: 'Light.' },
  { id: 'p09', src: '', width: 1600, height: 1200, title: 'Untitled 09', description: 'Detail.' },
  { id: 'p10', src: '', width: 1080, height: 1350, title: 'Untitled 10', description: 'Shadow.' },
  { id: 'p11', src: '', width: 1600, height: 1066, title: 'Untitled 11', description: 'Reflection.' },
  { id: 'p12', src: '', width: 1400, height: 1400, title: 'Untitled 12', description: 'Texture.' },
  { id: 'p13', src: '', width: 1600, height: 900, title: 'Untitled 13', description: 'Motion.' },
  { id: 'p14', src: '', width: 1100, height: 1600, title: 'Untitled 14', description: 'Still.' },
];
