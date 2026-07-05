import type { InspirationItem } from '@/data/types';
import styles from '@/components/lists/Lists.module.css';

export function InspirationList({ items }: { items: InspirationItem[] }) {
  return (
    <ul className={styles.iList}>
      {items.map((item, i) => {
        const inner = (
          <>
            <span className={styles.iTitle}>{item.title}</span>
            {item.meta && <span className={styles.iMeta}>{item.meta}</span>}
          </>
        );
        return (
          <li key={item.url ?? item.title + i}>
            {item.url ? (
              <a className={styles.iRow} href={item.url} target="_blank" rel="noreferrer">
                {inner}
              </a>
            ) : (
              <div className={styles.iRow}>{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
