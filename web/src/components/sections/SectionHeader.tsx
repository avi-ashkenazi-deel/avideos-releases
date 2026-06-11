import styles from './SectionHeader.module.css';

interface SectionHeaderProps {
  index?: string;
  title: string;
  intro?: string;
}

export function SectionHeader({ index, title, intro }: SectionHeaderProps) {
  return (
    <header className={styles.header}>
      {index && <span className={styles.index}>{index}</span>}
      <h2 className={styles.title}>{title}</h2>
      {intro && <p className={styles.intro}>{intro}</p>}
    </header>
  );
}
