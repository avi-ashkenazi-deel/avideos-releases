import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import vertexShader from '@/three/shaders/hero.vert.glsl';
import fragmentShader from '@/three/shaders/hero.frag.glsl';

interface HeroPlaneProps {
  paused?: boolean;
}

export function HeroPlane({ paused = false }: HeroPlaneProps) {
  const mesh = useRef<THREE.Mesh>(null);
  const { viewport, size } = useThree();
  const mouse = useRef(new THREE.Vector2(0.5, 0.5));
  const target = useRef(new THREE.Vector2(0.5, 0.5));

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(size.width, size.height) },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    }),
    // size handled in useFrame; only create once
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms,
      }),
    [uniforms],
  );

  useFrame((state, delta) => {
    uniforms.uResolution.value.set(
      state.size.width * state.viewport.dpr,
      state.size.height * state.viewport.dpr,
    );
    // Pointer in 0..1 space (y flipped to match uv)
    target.current.set(
      (state.pointer.x + 1) / 2,
      (state.pointer.y + 1) / 2,
    );
    mouse.current.lerp(target.current, 0.05);
    uniforms.uMouse.value.copy(mouse.current);
    if (!paused) uniforms.uTime.value += delta;
  });

  return (
    <mesh ref={mesh} scale={[viewport.width, viewport.height, 1]} material={material}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}
