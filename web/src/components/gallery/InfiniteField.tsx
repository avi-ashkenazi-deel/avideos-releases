import { useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { GalleryImage as GalleryImageData } from '@/data/types';
import { GalleryImage, type PlanePlacement } from './GalleryImage';

interface InfiniteFieldProps {
  items: GalleryImageData[]; // one representative image per project
  offset: React.MutableRefObject<THREE.Vector2>;
  offsetTarget: React.MutableRefObject<THREE.Vector2>;
  worldPerPixel: React.MutableRefObject<number>;
  anyActive: boolean;
  onSelect: (i: number) => void;
  draggedRef: React.MutableRefObject<boolean>;
  density: number; // 0.6 (sparse) … 1.6 (dense)
}

const BASE_W = 2.6;

export function InfiniteField({
  items,
  offset,
  offsetTarget,
  worldPerPixel,
  anyActive,
  onSelect,
  draggedRef,
  density,
}: InfiniteFieldProps) {
  const { viewport, size } = useThree();

  const { placements, tile } = useMemo(() => {
    const n = items.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.4)));
    const rows = Math.ceil(n / cols);
    const cell = (BASE_W * 1.9) / density; // higher density → tighter
    const tileW = cols * cell;
    const tileH = rows * cell;
    let seed = 1337;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const placements: PlanePlacement[] = items.map((item, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = col * cell - tileW / 2 + cell / 2;
      const cy = -(row * cell) + tileH / 2 - cell / 2;
      const jx = (rand() - 0.5) * cell * 0.35;
      const jy = (rand() - 0.5) * cell * 0.35;
      const z = (rand() - 0.5) * 2.4;
      const worldW = BASE_W;
      const worldH = BASE_W * (item.height / item.width);
      return { base: new THREE.Vector2(cx + jx, cy + jy), z, worldW, worldH };
    });
    return { placements, tile: { w: tileW, h: tileH } };
  }, [items, density]);

  useFrame(() => {
    offset.current.lerp(offsetTarget.current, 0.08);
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
          dimmed={anyActive}
          onSelect={() => onSelect(i)}
          draggedRef={draggedRef}
        />
      ))}
    </>
  );
}
