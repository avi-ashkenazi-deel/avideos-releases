import { tools } from '@/data/tools';
import { Thumb } from '@/components/lists/Thumb';
import styles from '@/components/lists/Lists.module.css';

export function ToolsBody() {
  return (
    <div className={styles.tools}>
      {tools.map((tool) => (
        <a key={tool.id} className={styles.tool} href={tool.url} target="_blank" rel="noreferrer">
          <div className={styles.toolThumb}>
            <Thumb src={tool.thumbnail} label={tool.name} />
          </div>
          <div className={styles.toolName}>{tool.name}</div>
          {tool.blurb && <div className={styles.toolBlurb}>{tool.blurb}</div>}
        </a>
      ))}
    </div>
  );
}
