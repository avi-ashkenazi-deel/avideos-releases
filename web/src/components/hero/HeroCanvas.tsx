import { Canvas } from '@react-three/fiber';
import { HeroPlane } from './HeroPlane';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

export function HeroCanvas() {
  const reduced = usePrefersReducedMotion();
  return (
    <Canvas
      orthographic
      camera={{ position: [0, 0, 1], zoom: 1 }}
      dpr={[1, 2]}
      gl={{ antialias: false, powerPreference: 'low-power' }}
      style={{ position: 'absolute', inset: 0 }}
      aria-hidden="true"
    >
      <HeroPlane paused={reduced} />
    </Canvas>
  );
}
