import { Page } from '@/components/layout/Page';
import { writing } from '@/data/writing';
import { formatMonthYear } from '@/lib/format';
import styles from '@/components/lists/Lists.module.css';

export default function Writing() {
  const items = [...writing].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <Page index="01" title="Writing" intro="Posts, essays and conversations — from LinkedIn, the blog and Substack.">
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.id}>
            <a
              className={styles.row}
              href={item.url}
              target="_blank"
              rel="noreferrer"
            >
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>{item.title}</div>
                <p className={styles.rowExcerpt}>{item.excerpt}</p>
              </div>
              <div className={styles.rowMeta}>
                <span className={styles.tag}>{item.source}</span>
                <span className={styles.date}>{formatMonthYear(item.date)}</span>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </Page>
  );
}
