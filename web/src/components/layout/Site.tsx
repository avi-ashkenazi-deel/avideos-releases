import { lazy, Suspense, useEffect } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Nav } from './Nav';
import styles from './Site.module.css';

const OnePage = lazy(() => import('@/pages/OnePage'));
const Article = lazy(() => import('@/pages/Article'));
const Inspiration = lazy(() => import('@/pages/Inspiration'));
const Snapshots = lazy(() => import('@/pages/Snapshots'));

export function Site() {
  const navigate = useNavigate();
  const location = useLocation();

  // Start non-home routes at the top.
  useEffect(() => {
    if (location.pathname !== '/') window.scrollTo(0, 0);
  }, [location.pathname]);

  const scrollToId = (id: string) => {
    if (id === 'top') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const onSection = (id: string) => {
    if (location.pathname !== '/') {
      navigate('/');
      requestAnimationFrame(() => requestAnimationFrame(() => scrollToId(id)));
    } else {
      scrollToId(id);
    }
  };

  return (
    <div className={styles.site}>
      <Nav onSection={onSection} />
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<main className={styles.main}><OnePage /></main>} />
          <Route
            path="/writing/:slug"
            element={<main className={styles.main}><Article /></main>}
          />
          <Route
            path="/inspiration"
            element={<main className={styles.main}><Inspiration /></main>}
          />
          <Route path="/snapshots" element={<div className={styles.gallery}><Snapshots /></div>} />
          <Route path="/snapshots/:id" element={<div className={styles.gallery}><Snapshots /></div>} />
          <Route path="*" element={<main className={styles.main}><OnePage /></main>} />
        </Routes>
      </Suspense>
    </div>
  );
}
