import { writing } from '@/data/writing';
import { formatMonthYear } from '@/lib/format';
import styles from '@/components/lists/Lists.module.css';

export function WritingBody() {
  const items = [...writing].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <ul className={styles.list}>
      {items.map((item) => (
        <li key={item.id}>
          <a className={styles.row} href={item.url} target="_blank" rel="noreferrer">
            <span className={styles.rowDate}>{formatMonthYear(item.date)}</span>
            <div className={styles.rowMain}>
              <div className={styles.rowTitle}>{item.title}</div>
              {item.excerpt && <p className={styles.rowExcerpt}>{item.excerpt}</p>}
            </div>
            <span className={styles.rowCat}>{item.source}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
