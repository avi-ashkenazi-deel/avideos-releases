import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const Home = lazy(() => import('./pages/Home'));
const Writing = lazy(() => import('./pages/Writing'));
const Talks = lazy(() => import('./pages/Talks'));
const Projects = lazy(() => import('./pages/Projects'));
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'));
const Tools = lazy(() => import('./pages/Tools'));
const Gallery = lazy(() => import('./pages/Gallery'));
const Photography = lazy(() => import('./pages/Photography'));
const About = lazy(() => import('./pages/About'));
const Socials = lazy(() => import('./pages/Socials'));

export const routes: RouteObject[] = [
  { path: '/', element: <Home /> },
  { path: '/writing', element: <Writing /> },
  { path: '/talks', element: <Talks /> },
  { path: '/projects', element: <Projects /> },
  { path: '/projects/:id', element: <ProjectDetail /> },
  { path: '/tools', element: <Tools /> },
  { path: '/gallery', element: <Gallery /> },
  { path: '/gallery/:id', element: <Gallery /> },
  { path: '/photography', element: <Photography /> },
  { path: '/photography/:id', element: <Photography /> },
  { path: '/about', element: <About /> },
  { path: '/socials', element: <Socials /> },
  { path: '*', element: <Home /> },
];
