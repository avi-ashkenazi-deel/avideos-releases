import { useNavigate, useParams } from 'react-router-dom';
import { writing } from '@/data/writing';
import articles from '@/data/articles.json';
import { formatFullDate } from '@/lib/format';
import { Footer } from '@/components/layout/Footer';
import styles from './Article.module.css';

const articleMap = articles as Record<string, string>;

export default function Article() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const item = writing.find((w) => w.id === slug);
  const raw = slug ? articleMap[slug] : undefined;
  // Article HTML uses absolute /images/ paths; prefix Vite's base so they
  // resolve under a project subpath (GitHub Pages) as well as the root.
  const base = import.meta.env.BASE_URL;
  const html = raw ? raw.replaceAll('src="/images/', `src="${base}images/`) : undefined;

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

      <Footer />
    </div>
  );
}
