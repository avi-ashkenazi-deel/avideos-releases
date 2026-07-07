import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { GalleryImage as GalleryImageData } from '@/data/types';
import { makePlaceholderTexture } from './texture';
import { asset } from '@/lib/asset';

export interface PlanePlacement {
  base: THREE.Vector2;
  z: number;
  worldW: number;
  worldH: number;
}

interface GalleryImageProps {
  item: GalleryImageData;
  placement: PlanePlacement;
  offset: React.MutableRefObject<THREE.Vector2>;
  tile: { w: number; h: number };
  dimmed: boolean; // a project is open — recede
  onSelect: () => void;
  draggedRef: React.MutableRefObject<boolean>;
}

function wrap(value: number, size: number): number {
  return ((((value + size / 2) % size) + size) % size) - size / 2;
}

export function GalleryImage({
  item,
  placement,
  offset,
  tile,
  dimmed,
  onSelect,
  draggedRef,
}: GalleryImageProps) {
  const mesh = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const [hovered, setHovered] = useState(false);

  const [texture, setTexture] = useState<THREE.Texture>(() => makePlaceholderTexture(item));
  useEffect(() => {
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(
      asset(item.src),
      (tex) => {
        if (cancelled) return;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        setTexture(tex);
      },
      undefined,
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [item.src]);

  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const x = wrap(placement.base.x + offset.current.x, tile.w);
    const y = wrap(placement.base.y + offset.current.y, tile.h);
    m.position.set(x, y, placement.z);
    const target = dimmed ? 1 : hovered ? 1.06 : 1;
    m.scale.setScalar(THREE.MathUtils.lerp(m.scale.x, target, 0.18));
    if (matRef.current) {
      matRef.current.opacity = THREE.MathUtils.lerp(
        matRef.current.opacity,
        dimmed ? 0.1 : 1,
        0.16,
      );
    }
    tmp; // keep ref alive
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (draggedRef.current) return;
    onSelect();
  };

  return (
    <mesh
      ref={mesh}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = '';
      }}
      onClick={handleClick}
    >
      <planeGeometry args={[placement.worldW, placement.worldH]} />
      <meshBasicMaterial ref={matRef} map={texture} transparent opacity={1} toneMapped={false} />
    </mesh>
  );
}
