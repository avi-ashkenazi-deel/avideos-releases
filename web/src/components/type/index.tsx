import type { ReactNode } from 'react';
import styles from './Type.module.css';

type El = 'h1' | 'h2' | 'h3' | 'p' | 'span' | 'div';

interface BaseProps {
  children: ReactNode;
  as?: El;
  className?: string;
}

function cx(...parts: (string | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

export function Heading({ children, as = 'h1', className }: BaseProps) {
  const Tag = as;
  return <Tag className={cx(styles.heading, className)}>{children}</Tag>;
}

export function Lead({ children, as = 'p', className }: BaseProps) {
  const Tag = as;
  return <Tag className={cx(styles.lead, className)}>{children}</Tag>;
}

export function Meta({ children, as = 'span', className }: BaseProps) {
  const Tag = as;
  return <Tag className={cx(styles.meta, className)}>{children}</Tag>;
}
