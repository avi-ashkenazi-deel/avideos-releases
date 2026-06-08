import { Page } from '@/components/layout/Page';
import { about } from '@/data/about';
import styles from './About.module.css';

export default function About() {
  const paragraphs = about.long.split('\n\n');
  return (
    <Page index="07" title="About">
      <div className={styles.body}>
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    </Page>
  );
}
