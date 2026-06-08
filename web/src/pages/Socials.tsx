import { Page } from '@/components/layout/Page';
import { socials } from '@/data/socials';
import styles from './Socials.module.css';

export default function Socials() {
  return (
    <Page index="08" title="Socials" intro="Find me elsewhere.">
      <ul className={styles.list}>
        {socials.map((s) => (
          <li key={s.id}>
            <a className={styles.row} href={s.url} target="_blank" rel="noreferrer">
              <span className={styles.label}>{s.label}</span>
              <span className={styles.handle}>
                {s.handle ? `${s.handle} ↗` : '↗'}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Page>
  );
}
