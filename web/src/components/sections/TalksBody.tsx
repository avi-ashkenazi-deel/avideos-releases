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
            <div className={styles.rowMain}>
              <div className={styles.rowTitle}>{talk.title}</div>
              {talk.event && <p className={styles.rowExcerpt}>{talk.event}</p>}
            </div>
            <div className={styles.rowMeta}>
              <span className={styles.tag}>Watch ↗</span>
              <span className={styles.date}>{formatFullDate(talk.date)}</span>
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
