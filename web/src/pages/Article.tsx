import { useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { writing } from '@/data/writing';
import articles from '@/data/articles.json';
import { formatFullDate } from '@/lib/format';
import { readingOrder } from '@/lib/reading';
import { usePullToNext } from '@/hooks/usePullToNext';
import { Footer } from '@/components/layout/Footer';
import styles from './Article.module.css';

const articleMap = articles as Record<string, string>;

export default function Article() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const item = writing.find((w) => w.id === slug);
  const raw = slug ? articleMap[slug] : undefined;
  const base = import.meta.env.BASE_URL;
  const html = raw ? raw.replaceAll('src="/images/', `src="${base}images/`) : undefined;

  const order = useMemo(() => readingOrder(), []);
  const idx = order.findIndex((w) => w.id === slug);
  const next = idx >= 0 ? order[(idx + 1) % order.length] : undefined;
  const sectionChange = !!(next && item && next.source !== item.source);

  const goNext = useCallback(() => {
    if (next) navigate(`/writing/${next.id}`);
  }, [next, navigate]);

  const progress = usePullToNext(!!next && !!html, goNext);

  const backToWriting = () => {
    navigate('/');
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document.getElementById('writing')?.scrollIntoView({ block: 'start' }),
      ),
    );
  };

  if (!item || !html) {
    return (
      <div className={`container ${styles.wrap}`}>
        <button className={styles.back} onClick={backToWriting}>
          Writing
        </button>
        <p style={{ marginTop: '2rem' }}>Article not found.</p>
      </div>
    );
  }

  return (
    <div className={`container ${styles.wrap}`}>
      <button className={styles.back} onClick={backToWriting}>
        Writing
      </button>

      <header className={styles.head}>
        <div className={styles.meta}>
          {item.source} · {formatFullDate(item.date)}
        </div>
        <h1 className={styles.title}>{item.title}</h1>
      </header>

      <div className={styles.prose} dangerouslySetInnerHTML={{ __html: html }} />

      <p className={styles.source}>
        <a href={item.url} target="_blank" rel="noreferrer">
          Originally published on superavi.com
        </a>
      </p>

      {next && (
        <button className={styles.continue} onClick={goNext} aria-label={`Next: ${next.title}`}>
          {sectionChange ? (
            <span className={styles.jump}>{next.source}</span>
          ) : (
            <span className={styles.contLabel}>Continue reading</span>
          )}
          <span className={styles.nextTitle}>{next.title}</span>
          <span className={styles.pullHint}>Pull, scroll or click to continue</span>
        </button>
      )}

      {next && progress > 0.01 && (
        <div className={styles.pullBar} style={{ transform: `scaleX(${progress})` }} />
      )}

      <Footer />
    </div>
  );
}
