import { about } from '@/data/about';
import styles from '@/pages/About.module.css';

export function AboutBody() {
  const paragraphs = about.long.split('\n\n');
  return (
    <div className={styles.body}>
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}
