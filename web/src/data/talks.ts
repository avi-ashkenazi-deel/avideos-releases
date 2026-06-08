import type { Talk } from './types';

// Talks with a date and a link to watch (YouTube where available).
export const talks: Talk[] = [
  {
    id: 'designing-up-2025',
    title: 'Shaping the future of design, AI, culture & leadership',
    event: 'Designing Up Podcast',
    date: '2025-11-15',
    youtubeUrl: 'https://www.youtube.com/watch?v=QPO0FGCM_IM',
  },
  {
    id: 'ecom-2023',
    title: 'Editing commerce',
    event: "ECOM Design Conference '23",
    date: '2023-02-04',
    youtubeUrl: 'https://superavi.com',
  },
  {
    id: 'uxlive-2022',
    title: 'Connecting to others',
    event: "UX Live '22",
    date: '2022-12-07',
    youtubeUrl: 'https://superavi.com',
  },
];
