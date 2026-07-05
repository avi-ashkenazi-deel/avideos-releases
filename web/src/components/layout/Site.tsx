import { lazy, Suspense } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Nav } from './Nav';
import styles from './Site.module.css';

const OnePage = lazy(() => import('@/pages/OnePage'));
const Gallery = lazy(() => import('@/pages/Gallery'));
const Photography = lazy(() => import('@/pages/Photography'));

export function Site() {
  const navigate = useNavigate();
  const location = useLocation();

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
          <Route
            path="/"
            element={
              <main className={styles.main}>
                <OnePage />
              </main>
            }
          />
          <Route path="/gallery" element={<div className={styles.gallery}><Gallery /></div>} />
          <Route path="/gallery/:id" element={<div className={styles.gallery}><Gallery /></div>} />
          <Route path="/photography" element={<div className={styles.gallery}><Photography /></div>} />
          <Route path="/photography/:id" element={<div className={styles.gallery}><Photography /></div>} />
          <Route
            path="*"
            element={
              <main className={styles.main}>
                <OnePage />
              </main>
            }
          />
        </Routes>
      </Suspense>
    </div>
  );
}
