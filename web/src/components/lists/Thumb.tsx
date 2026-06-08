import { useState } from 'react';
import styles from './Thumb.module.css';

interface ThumbProps {
  src?: string;
  label: string;
}

/** Renders an image, falling back to a typographic placeholder if it fails. */
export function Thumb({ src, label }: ThumbProps) {
  const [failed, setFailed] = useState(false);
  const usable = src && src !== '#' && !failed;

  if (!usable) {
    const initials = label
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('');
    return <div className={styles.placeholder}>{initials}</div>;
  }

  return (
    <img
      src={src}
      alt={label}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
