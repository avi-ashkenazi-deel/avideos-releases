import type { Tool } from './types';

// Apps Avi has built. Drop thumbnails in /public/images/tools/ and set `url`.
export const tools: Tool[] = [
  {
    id: 'vidit',
    name: 'Vidit',
    blurb: 'A cinematic video editor.',
    thumbnail: '/images/tools/vidit.svg',
    url: '#',
  },
  {
    id: 'links',
    name: 'Links',
    blurb: 'A second brain tool.',
    thumbnail: '/images/tools/links.svg',
    url: '#',
  },
  {
    id: 'product-shots',
    name: 'Product Shots',
    blurb: 'TBD.',
    thumbnail: '/images/tools/product-shots.svg',
    url: '#',
  },
];
