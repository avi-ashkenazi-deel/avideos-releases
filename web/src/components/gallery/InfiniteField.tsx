import { useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { GalleryImage as GalleryImageData } from '@/data/types';
import { GalleryImage, type PlanePlacement } from './GalleryImage';

interface InfiniteFieldProps {
  items: GalleryImageData[];
  offset: React.MutableRefObject<THREE.Vector2>; // eased current offset (updated here)
  offsetTarget: React.MutableRefObject<THREE.Vector2>; // drag target
  worldPerPixel: React.MutableRefObject<number>;
  activeIndex: number | null;
  onSelect: (i: number) => void;
  draggedRef: React.MutableRefObject<boolean>;
}

const BASE_W = 2.6; // base plane width in world units

export function InfiniteField({
  items,
  offset,
  offsetTarget,
  worldPerPixel,
  activeIndex,
  onSelect,
  draggedRef,
}: InfiniteFieldProps) {
  const { viewport, size } = useThree();

  const { placements, tile } = useMemo(() => {
    const n = items.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.4)));
    const rows = Math.ceil(n / cols);
    const cellW = BASE_W * 1.8;
    const cellH = BASE_W * 1.8;
    const tileW = cols * cellW;
    const tileH = rows * cellH;

    // deterministic pseudo-random so layout is stable across renders
    let seed = 1337;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const placements: PlanePlacement[] = items.map((item, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = col * cellW - tileW / 2 + cellW / 2;
      const cy = -(row * cellH) + tileH / 2 - cellH / 2;
      const jx = (rand() - 0.5) * cellW * 0.35;
      const jy = (rand() - 0.5) * cellH * 0.35;
      const z = (rand() - 0.5) * 2.4;
      const worldW = BASE_W;
      const worldH = BASE_W * (item.height / item.width);
      return {
        base: new THREE.Vector2(cx + jx, cy + jy),
        z,
        worldW,
        worldH,
      };
    });

    return { placements, tile: { w: tileW, h: tileH } };
  }, [items]);

  useFrame(() => {
    // momentum glide toward the drag target
    offset.current.lerp(offsetTarget.current, 0.08);
    // keep the pixel->world conversion fresh for the drag handler
    worldPerPixel.current = viewport.width / size.width;
  });

  return (
    <>
      {items.map((item, i) => (
        <GalleryImage
          key={item.id}
          item={item}
          placement={placements[i]}
          offset={offset}
          tile={tile}
          active={activeIndex === i}
          anyActive={activeIndex !== null}
          onSelect={() => onSelect(i)}
          draggedRef={draggedRef}
        />
      ))}
    </>
  );
}
