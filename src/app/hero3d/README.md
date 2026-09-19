# Hero3D — customization scaffold

The landing-page hero is a real-time 3D scene driven by react-three-fiber.
Everything you can see and hear is parameterized, and most parameters are
tunable from a single config file.

## Files

- **`config.ts`** — every tunable number for the scene. Change a value,
  save, refresh the browser. That's the whole loop.
- **`../Hero3D.tsx`** — the actual scene code. Imports from `config.ts`.
  Each effect is a small component (HammerMesh, ChargeAura, TrailDust,
  ShockwaveRing, CameraShake, Sparks) so you can copy + paste one and
  riff on it.
- **`../Hero3DMount.tsx`** — tiny client-side wrapper. Don't touch
  unless you're moving Hero3D to a different route.

## What's in the scene

| What you see / hear | Driven by | Where to tweak |
|---|---|---|
| Anvil sitting at center | `<AnvilMesh>` in Hero3D.tsx | `ANVIL_SCALE` |
| Hammer floating around the anvil | `computeOrbitPos()` in Hero3D.tsx | `ORBIT_*` |
| Hammer's slow tumble in idle | idle branch of HammerMesh useFrame | `IDLE_*` |
| Hammer follows cursor on click | engaged branch of HammerMesh useFrame | `FOLLOW_LERP`, `ENGAGE_PLANE_Z` |
| Hammer can't pass through anvil | `pushOutOfBox()` in HammerMesh | `COLLISION_PADDING` |
| Hold-to-charge windup (size + lightning + halo) | `<ChargeAura>` + scale lerp in HammerMesh | `CHARGE_FULL_MS`, `HAMMER_SCALE_FULL_CHARGE`, `SURGE_THRESHOLD` |
| Max-charge hammer shudder | engaged branch (after-scale shake block) | `MAX_CHARGE_SHAKE_*` |
| Sparkle trail behind hammer | `<TrailDust>` | `TRAIL_*` |
| Tap-to-release-without-striking | `endCharge()` in Hero3D wrapper | `TAP_THRESHOLD_MS` |
| Swing kick on release | `swing` branch of HammerMesh useFrame | `SWING_*` |
| Strike sparks (yellow → red bursts) | `<Sparks>` + `handleImpact()` | inline in `handleImpact` |
| Strike shockwave rings | `<ShockwaveRing>` | inline in `ShockwaveRing` (lifetime, peakScale) |
| Anvil tremor on impact | `<AnvilMesh>` shake reads | inline in `handleImpact` (shakeRef.until math) |
| Camera shake on heavy strikes | `<CameraShake>` | inline in `handleImpact` (cameraShakeRef) |
| White screen flash on strike | overlay `<div>` in Hero3D wrapper | inline in `triggerFlash` and overlay style |
| Layered clang + thunder audio | `playStrike()` | inline volume/pitch math |
| Right-click to orbit camera | drei `<OrbitControls>` | OrbitControls props |

The "inline" rows aren't in `config.ts` yet because the math is
power-relative (e.g. `220 + power * 320`). If you want to centralise
those, it's straightforward — promote them to named constants in
`config.ts` and import.

## How to add a new effect

The pattern in Hero3D.tsx is consistent:

1. **State or refs** owned by `SceneContent` for anything that crosses
   components (e.g. `hammerWorldPosRef` is shared between HammerMesh
   and TrailDust).
2. **Component** that takes the refs/props it needs and runs its own
   `useFrame` callback. Position it at world-space origin and let the
   shared ref drive its in-frame behaviour.
3. **Mount** it inside `<SceneContent>`'s JSX in the right z-order.
   `useFrame` callbacks run in registration order; mount later if you
   need to apply something on top of earlier passes (CameraShake is a
   good example).
4. **Tunables** added as named constants in `config.ts`, imported into
   Hero3D.tsx.

A minimal new-effect template:

```tsx
function MyEffect({ worldPosRef }: {
  worldPosRef: React.MutableRefObject<THREE.Vector3>;
}) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (!ref.current) return;
    ref.current.position.copy(worldPosRef.current);
    // ...
  });
  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.5, 16, 16]} />
      <meshBasicMaterial color="violet" transparent opacity={0.5} />
    </mesh>
  );
}
```

Then in `SceneContent`:

```tsx
<MyEffect worldPosRef={hammerWorldPosRef} />
```

## 3D effect vs. video overlay — which should you use?

This is a real fork in the road. Both are valid; they're for different
problems.

### 3D effects (current approach for everything)

You build the effect from real Three.js geometry — meshes, lines,
particles — driven by parameters that change every frame.

**Pick 3D when:**

- The effect is **reactive** to live values (charge level, cursor
  position, power, time). Lightning bolts that scale with charge,
  sparkle density that follows the hammer, shockwaves sized by power
  — these are 3D because they're parameterized.
- It needs to **compose with the scene** — occlusion, perspective,
  proper depth. A shockwave ring around the anvil's hit point should
  shrink when the camera orbits to a far angle. A pre-rendered video
  ring would betray the camera move.
- You want **infinite variation** — different power levels, different
  angles, different colors — without baking each variant.
- You want it **light** — even 100+ instanced particles cost less
  bandwidth than a 5MB transparent video.

**Cost:** more code, more thought. You're authoring the effect by
hand instead of importing one.

### Video overlay

You pre-render a transparent-background video in After Effects /
Houdini / Cavalry / Unreal, export with alpha (WebM with VP9 alpha
or HEVC with alpha — Safari quirks apply), drop it in `public/`,
and play it as a `<video>` element absolutely-positioned over the
canvas.

**Pick video overlay when:**

- The effect is **a single one-shot moment** that doesn't need to
  react to anything. A "max charge release" frame that always plays
  the same way? Video is fine. A "this is the cinematic shot of the
  product" intro animation? Video.
- The look is **art-directed in something Three.js can't easily do**.
  Photoreal volumetric explosions, hand-keyframed character motion,
  Houdini fluid sims — you'd burn weeks recreating that in real-time.
- The effect is **rare** — fires once per session — so the file size
  doesn't matter.
- You're **collaborating with a VFX artist** who doesn't write
  shaders. They author in their tool, you drop in the file.

**Cost:** file size (often 1–10MB per clip), no reactivity, alpha
codec compatibility headaches across browsers, mobile autoplay rules.

### Hybrid (most production scenes use this)

Real 3D for the persistent stuff that needs to react (hammer, anvil,
sparks, shockwaves), with **one or two pre-rendered video overlays**
for specific cinematic moments — e.g. a "first time the user hits
max power" reveal animation that fires once per session.

**Wiring a video overlay** (no code shipped — just the recipe):

```tsx
// 1. Drop /public/effects/max-charge-release.webm
// 2. In Hero3D.tsx wrapper:
const videoRef = useRef<HTMLVideoElement>(null);
function fireOverlay() {
  if (!videoRef.current) return;
  videoRef.current.currentTime = 0;
  videoRef.current.play();
}

return (
  <div ...>
    <video
      ref={videoRef}
      src="/effects/max-charge-release.webm"
      muted playsInline
      style={{
        position: "absolute", inset: 0,
        width: "100%", height: "100%",
        objectFit: "cover",
        pointerEvents: "none",
        mixBlendMode: "screen",
        zIndex: 6,
      }}
    />
    <Canvas ...>...</Canvas>
  </div>
);
```

Then call `fireOverlay()` from your impact handler when conditions
are met (e.g. `if (power > 0.95) fireOverlay()`).

## Asset generation

When you want a new asset, the existing pipeline is:

- **3D models (GLB)** — Meshy AI image-to-3d. Your reference docs are
  at `~/.anvil-cli.meshy.md`. Drop a reference image, get back a GLB
  with PBR maps.
- **Sound effects (MP3)** — ElevenLabs sound-generation. Reference at
  `~/.anvil-cli.elevenlabs.md`. The current `anvil-thunder.mp3` was
  generated with the prompt: *"thunderous deep boom of a giant hammer
  striking an anvil with low metallic ring decay and sub-bass rumble,
  single hit, no music"*. You can iterate on prompts and regen until
  it lands the feel you want, then save into `/public/sounds/`.
- **Transparent video overlays** — author in After Effects (or open-
  source: Cavalry, Blender → Eevee compositor). Export to WebM with
  VP9 alpha (`-c:v libvpx-vp9 -pix_fmt yuva420p`) or HEVC with alpha
  for Safari. Drop into `/public/effects/`.

## Performance notes

- Capped: sparks at 280, trail at 120, shockwaves at 8. These caps
  exist because mobile GPUs choke on unbounded particle lists. If you
  raise them, profile with Chrome DevTools' frame-timing.
- `dpr={[1, 2]}` on the Canvas caps the device-pixel-ratio at 2 so
  retina/4K screens don't render at 4x cost.
- `useGLTF.preload(...)` is called at module level so the GLBs start
  fetching before the component mounts — first paint is faster.

## When something breaks

The most common gotcha shipped on this scene was setting `priority=1`
on a `useFrame` — R3F treats any non-zero priority as "manual render
mode" and **stops auto-rendering the scene** until you call
`gl.render()` yourself. Symptom: blank canvas, no errors. Fix: drop
the priority parameter, use JSX ordering to control which `useFrame`
runs later.

## Related

- Whole scene: `src/app/Hero3D.tsx`
- Mount point: `src/app/page.tsx` (look for `<Hero3DMount />`)
- Tooling refs: `~/.anvil-cli.meshy.md`, `~/.anvil-cli.elevenlabs.md`
