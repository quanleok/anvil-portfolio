"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import {
  ContactShadows,
  Environment,
  OrbitControls,
  Preload,
  useGLTF,
} from "@react-three/drei";
import * as THREE from "three";
import { ANVIL_GLB, ANVIL_SCALE } from "./hero3d/config";

// Minimal hero scene: just the anvil. Rotates slowly on its own; user
// can click + drag (or right-click + drag, or touch + drag) to orbit
// the camera around it.
//
// The full interactive build — hammer orbiting on a tilted ring, hover
// + click-to-grab, charge windup with hammer scale-up + max-charge
// shudder, swing animation, strike sparks + shockwave + screen flash
// + camera shake + thunder/clang audio, summon-overlay video, sparkle
// trail, lightning aura — is preserved at:
//   archive/Hero3D-with-hammer.tsx
// To revive any of those features later: copy specific components or
// the whole file back. The hero3d/config.ts module still exports the
// constants the archive references, so the revived version will run
// without further plumbing.

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

function AnvilMesh({ reducedMotion }: { reducedMotion: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const { scene } = useGLTF(ANVIL_GLB);
  // Clone so a shared cache doesn't leak transforms into other mounts.
  const cloned = useMemo(() => scene.clone(true), [scene]);

  useFrame((state, delta) => {
    if (!ref.current) return;
    if (reducedMotion) return;
    const t = state.clock.elapsedTime;
    // Continuous slow spin around Y. Matches the original
    // <model-viewer> auto-rotate — keeps spinning even while the
    // user is dragging, so both motions happen simultaneously.
    ref.current.rotation.y += delta * THREE.MathUtils.degToRad(14);
    // Subtle vertical bob.
    ref.current.position.y = Math.sin(t * 1.05) * 0.06;
  });

  return (
    <primitive ref={ref} object={cloned} scale={ANVIL_SCALE} position={[0, 0, 0]} />
  );
}

function SceneContent() {
  const reducedMotion = useReducedMotion();
  return (
    <>
      <ambientLight intensity={0.3} />
      <directionalLight
        position={[3, 4, 2]}
        intensity={0.85}
        castShadow
        shadow-mapSize={[1024, 1024]}
      />
      <directionalLight position={[-2, 3, -1]} intensity={0.35} />
      {/* Warmer industrial HDRI matches the forge/anvil mood far
          better than the clinical "studio" preset. environment-
          Intensity bumped so PBR materials catch richer reflections. */}
      <Suspense fallback={null}>
        <Environment preset="warehouse" environmentIntensity={1.0} />
      </Suspense>
      <AnvilMesh reducedMotion={reducedMotion} />
      <ContactShadows
        position={[0, -0.95, 0]}
        opacity={0.5}
        scale={6}
        blur={2.4}
        far={3}
        resolution={512}
      />
      {/* User interaction: click + drag (any button) or single-touch
          drag to orbit the camera around the anvil. Free rotation —
          no polar/azimuth limits. The anvil's own continuous spin
          (handled in AnvilMesh's useFrame) keeps going while the
          user drags, so both motions happen at once like the
          original <model-viewer> setup. */}
      <OrbitControls
        enableZoom={false}
        enablePan={false}
        enableDamping
        dampingFactor={0.12}
        rotateSpeed={0.85}
        target={[0, 0, 0]}
        mouseButtons={{
          LEFT: THREE.MOUSE.ROTATE,
          MIDDLE: undefined as unknown as THREE.MOUSE,
          RIGHT: THREE.MOUSE.ROTATE,
        }}
        touches={{
          ONE: THREE.TOUCH.ROTATE,
          TWO: THREE.TOUCH.ROTATE,
        }}
      />
    </>
  );
}

useGLTF.preload(ANVIL_GLB);

export default function Hero3D() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        // Suppress the browser context menu so right-click drag
        // (also wired to OrbitControls) feels integrated.
        touchAction: "none",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [0, 0.4, 4.4], fov: 32 }}
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: false }}
        style={{ width: "100%", height: "100%" }}
      >
        <Suspense fallback={null}>
          <SceneContent />
          <Preload all />
        </Suspense>
      </Canvas>
    </div>
  );
}
