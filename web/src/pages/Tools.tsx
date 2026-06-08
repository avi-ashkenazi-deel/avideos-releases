import { Page } from '@/components/layout/Page';
import { tools } from '@/data/tools';
import { Thumb } from '@/components/lists/Thumb';
import styles from '@/components/lists/Lists.module.css';

export default function Tools() {
  return (
    <Page index="04" title="Tools" intro="Apps I've built. Tap through to try them.">
      <div className={styles.grid}>
        {tools.map((tool) => (
          <a
            key={tool.id}
            className={styles.card}
            href={tool.url}
            target="_blank"
            rel="noreferrer"
          >
            <div className={styles.thumb}>
              <Thumb src={tool.thumbnail} label={tool.name} />
            </div>
            <div className={styles.cardName}>{tool.name}</div>
            {tool.blurb && <div className={styles.cardBlurb}>{tool.blurb}</div>}
          </a>
        ))}
      </div>
    </Page>
  );
}
