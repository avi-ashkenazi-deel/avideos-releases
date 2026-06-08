import type { Project } from './types';

export const projects: Project[] = [
  {
    id: 'vidit',
    name: 'Vidit',
    tagline: 'A cinematic video editor.',
    description:
      'Vidit is a video editor built around a cinematic feel — fast, expressive and focused on the craft of cutting. More detail coming soon.',
    year: '2025',
    role: 'Design & build',
    cover: '/images/projects/vidit-cover.svg',
    links: [{ label: 'Visit', url: '#' }],
  },
  {
    id: 'links',
    name: 'Links',
    tagline: 'A second brain tool.',
    description:
      'Links is a second-brain tool for capturing and connecting the things you read, watch and think about. More detail coming soon.',
    year: '2025',
    role: 'Design & build',
    cover: '/images/projects/links-cover.svg',
    links: [{ label: 'Visit', url: '#' }],
  },
  {
    id: 'product-shots',
    name: 'Product Shots',
    tagline: 'TBD.',
    description: 'A project to be revealed a bit later.',
    role: 'Design & build',
    cover: '/images/projects/product-shots-cover.svg',
  },
];
