import { talks } from '@/data/talks';
import { formatFullDate } from '@/lib/format';
import styles from '@/components/lists/Lists.module.css';

export function TalksBody() {
  const items = [...talks].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <ul className={styles.list}>
      {items.map((talk) => (
        <li key={talk.id}>
          <a className={styles.row} href={talk.youtubeUrl} target="_blank" rel="noreferrer">
            <span className={styles.rowDate}>{formatFullDate(talk.date)}</span>
            <div className={styles.rowMain}>
              <div className={styles.rowTitle}>{talk.title}</div>
              {talk.event && <p className={styles.rowExcerpt}>{talk.event}</p>}
            </div>
            <span className={styles.rowCat}>Watch ↗</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
