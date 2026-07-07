import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { WritingItem } from '@/data/types';
import articles from '@/data/articles.json';
import { formatFullDate } from '@/lib/format';
import { readingOrder } from '@/lib/reading';
import { Footer } from '@/components/layout/Footer';
import styles from './Article.module.css';

const articleMap = articles as Record<string, string>;
const BASE = import.meta.env.BASE_URL;
const prep = (html: string) => html.replaceAll('src="/images/', `src="${BASE}images/`);

function Block({
  item,
  showSection,
  onActive,
}: {
  item: WritingItem;
  showSection: boolean;
  onActive: (item: WritingItem) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const html = useMemo(() => (articleMap[item.id] ? prep(articleMap[item.id]) : ''), [item.id]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) onActive(item);
      },
      { rootMargin: '0px 0px -80% 0px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [item, onActive]);

  return (
    <article className={styles.block}>
      {showSection && <div className={styles.sectionLabel}>{item.source}</div>}
      <header ref={ref} className={styles.head}>
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
    </article>
  );
}

export default function Article() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const order = useMemo(() => readingOrder(), []);
  const startIdx = order.findIndex((w) => w.id === slug);
  const total = startIdx < 0 ? 0 : order.length - startIdx;

  const [count, setCount] = useState(1);
  useEffect(() => {
    setCount(1);
    window.scrollTo(0, 0);
  }, [slug]);

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) setCount((c) => Math.min(total, c + 1));
      },
      { rootMargin: '800px 0px' }, // load the next article well before the end
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [total, slug]);

  // Reflect the article currently in view into the URL + document title (SEO).
  const onActive = useCallback((item: WritingItem) => {
    const path = `${BASE}writing/${item.id}`;
    if (window.location.pathname !== path) history.replaceState(null, '', path);
    document.title = `${item.title} — Avi Ashkenazi`;
  }, []);

  const backToWriting = () => {
    navigate('/');
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document.getElementById('writing')?.scrollIntoView({ block: 'start' }),
      ),
    );
  };

  if (startIdx < 0 || !slug || !articleMap[slug]) {
    return (
      <div className={`container ${styles.wrap}`}>
        <button className={styles.back} onClick={backToWriting}>
          Writing
        </button>
        <p style={{ marginTop: '2rem' }}>Article not found.</p>
      </div>
    );
  }

  const loaded = order.slice(startIdx, startIdx + count);

  return (
    <div className={`container ${styles.wrap}`}>
      <button className={styles.back} onClick={backToWriting}>
        Writing
      </button>

      {loaded.map((item, i) => (
        <Block
          key={item.id}
          item={item}
          showSection={i > 0 && item.source !== loaded[i - 1].source}
          onActive={onActive}
        />
      ))}

      <div ref={sentinel} aria-hidden="true" />
      <Footer />
    </div>
  );
}
