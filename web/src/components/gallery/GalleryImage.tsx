import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { GalleryImage as GalleryImageData } from '@/data/types';
import { makePlaceholderTexture } from './texture';
import { asset } from '@/lib/asset';

export interface PlanePlacement {
  base: THREE.Vector2; // base position within the tile
  z: number; // depth jitter
  worldW: number;
  worldH: number;
}

interface GalleryImageProps {
  item: GalleryImageData;
  placement: PlanePlacement;
  offset: React.MutableRefObject<THREE.Vector2>; // current (eased) drag offset
  tile: { w: number; h: number };
  active: boolean;
  anyActive: boolean;
  onSelect: () => void;
  draggedRef: React.MutableRefObject<boolean>;
}

function wrap(value: number, size: number): number {
  // wrap into [-size/2, size/2)
  return ((((value + size / 2) % size) + size) % size) - size / 2;
}

export function GalleryImage({
  item,
  placement,
  offset,
  tile,
  active,
  anyActive,
  onSelect,
  draggedRef,
}: GalleryImageProps) {
  const mesh = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const [hovered, setHovered] = useState(false);
  const { camera, size } = useThree();

  // Texture: real image if provided, else colorful placeholder.
  const [texture, setTexture] = useState<THREE.Texture>(() =>
    makePlaceholderTexture(item),
  );

  useEffect(() => {
    let cancelled = false;
    if (item.src && item.src !== '') {
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
        () => {
          /* keep placeholder on error */
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [item.src]);

  const opacityTarget = useRef(1);

  // Reusable temp vectors
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;

    if (active) {
      // Fit the active plane into a centered box in front of the camera.
      const fov = (camera as THREE.PerspectiveCamera).fov ?? 45;
      const activeZ = camera.position.z - 5;
      const dist = camera.position.z - activeZ;
      const visH = 2 * dist * Math.tan((fov * Math.PI) / 360);
      const visW = visH * (size.width / size.height);
      const fit = Math.min(
        (visW * 0.82) / placement.worldW,
        (visH * 0.78) / placement.worldH,
      );
      tmp.set(0, 0, activeZ);
      m.position.lerp(tmp, 0.16);
      const s = THREE.MathUtils.lerp(m.scale.x, fit, 0.16);
      m.scale.setScalar(s);
      opacityTarget.current = 1;
    } else {
      const x = wrap(placement.base.x + offset.current.x, tile.w);
      const y = wrap(placement.base.y + offset.current.y, tile.h);
      if (anyActive) {
        // Hold position, dim and shrink slightly behind the active one.
        m.position.lerp(tmp.set(x, y, placement.z), 0.12);
        const s = THREE.MathUtils.lerp(m.scale.x, 1, 0.16);
        m.scale.setScalar(s);
        opacityTarget.current = 0.12;
      } else {
        // Follow the drag directly for responsiveness.
        m.position.set(x, y, placement.z);
        const targetScale = hovered ? 1.06 : 1;
        const s = THREE.MathUtils.lerp(m.scale.x, targetScale, 0.18);
        m.scale.setScalar(s);
        opacityTarget.current = 1;
      }
    }

    if (matRef.current) {
      matRef.current.opacity = THREE.MathUtils.lerp(
        matRef.current.opacity,
        opacityTarget.current,
        0.16,
      );
    }
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (draggedRef.current) return; // ignore clicks that were really drags
    onSelect();
  };

  return (
    <mesh
      ref={mesh}
      scale={1}
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
      <meshBasicMaterial
        ref={matRef}
        map={texture}
        transparent
        opacity={1}
        toneMapped={false}
      />
    </mesh>
  );
}
