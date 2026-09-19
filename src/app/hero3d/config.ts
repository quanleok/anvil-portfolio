// Hero3D — central effect configuration.
//
// Every tunable parameter for the landing-page hero scene lives here.
// Edit a number, save, refresh the browser — that's the loop.
//
// Hero3D.tsx imports everything below; nothing else in the repo
// references these names, so renaming or restructuring is local.
//
// See README.md in this folder for what each effect does, how to
// design a new one, and how to decide between 3D effects (current
// approach) vs. video overlays.

import * as THREE from "three";

// ─── Asset paths ────────────────────────────────────────────────────
// 3D models live in /public; sound effects too. Replace any of these
// to swap the assets — the file just needs to exist at the path.
export const ANVIL_GLB = "/anvil.glb";
export const HAMMER_GLB = "/anvil-hammer.glb";
export const CLANG_MP3 = "/sounds/anvil-clang.mp3";
export const THUNDER_MP3 = "/sounds/anvil-thunder.mp3";
export const SIZZLE_MP3 = "/sounds/anvil-sizzle.mp3";

// ─── Model sizing ───────────────────────────────────────────────────
// Visual scale of each model. The anvil is a constant scale; the
// hammer's primitive scale is the "base size" — actual rendered
// size = primitive * group-scale, and the group scale ramps with
// charge level (see CHARGE section below).
export const ANVIL_SCALE = 0.64;
export const HAMMER_PRIMITIVE_SCALE = 0.14;
export const HAMMER_SCALE_IDLE = 1.0;
export const HAMMER_SCALE_ENGAGED = 1.03;
export const HAMMER_SCALE_FULL_CHARGE = 2.25; // bigger = more dramatic windup

// ─── Orbit (idle hammer "moon" path around the anvil) ───────────────
// The hammer traces a tilted ring around the anvil at idle. Tweak
// these to change where/how it floats.
export const ORBIT_RADIUS = 1.6; // distance from anvil center
export const ORBIT_PERIOD_SEC = 32; // seconds for a full lap (longer = slower)
export const ORBIT_TILT_DEG = 18; // ring tilts this much from horizontal
export const ORBIT_CENTER_Y = 0.15; // lifts the ring slightly above origin

// ─── Idle motion (layered on top of the orbit) ──────────────────────
// Once the orbit positions the hammer, these add subtle life on top:
// a vertical bob (so it doesn't read as sliding on a wire) and a
// slow 2-axis tumble (so the hammer's silhouette visibly rotates).
export const IDLE_BOB_AMPLITUDE = 0.09;
export const IDLE_BOB_FREQ = 0.7; // radians/sec → period ≈ 9s
export const IDLE_SELF_SPIN_DEG_PER_SEC = 18; // around local Y axis
export const IDLE_TUMBLE_DEG_PER_SEC = 7; // around local X axis

// ─── Engagement (when the hammer is grabbed by the cursor) ──────────
// Cursor projects onto a fixed-Z plane in front of the anvil while
// held, so the rendered hammer stays at consistent perceived size
// regardless of where on the orbit it was when grabbed.
export const ENGAGE_PLANE_Z = 0.3;

// Hammer's spawn pose — orbit position at t=0 (rightmost point of the
// ring). Computed from orbit constants so changing ORBIT_RADIUS
// automatically moves the spawn pose.
export const HAMMER_INITIAL = new THREE.Vector3(
  ORBIT_RADIUS,
  ORBIT_CENTER_Y,
  0,
);

// ─── Charge mechanic (click-and-hold windup) ────────────────────────
// CHARGE_FULL_MS: how long the user must hold for max power.
// MAX_CHARGE_SHAKE_*: past this charge level the hammer shudders.
// TAP_THRESHOLD_MS: releases under this are taps (no swing).
export const CHARGE_FULL_MS = 2200;
export const MAX_CHARGE_SHAKE_THRESHOLD = 0.85;
export const MAX_CHARGE_SHAKE_AMOUNT = 0.045;
export const TAP_THRESHOLD_MS = 120;

// ─── Swing animation (release fires this) ───────────────────────────
// The swing is a brief forward kick toward the anvil + recoil.
// Strike-on-bbox-overlap fires only during the kick's first SWING_HIT_
// WINDOW_END fraction; recoil portion is always non-striking.
export const SWING_DURATION_MS = 280;
export const SWING_KICK_DISTANCE = 0.55; // world-units of forward travel at full power
export const SWING_HIT_WINDOW_END = 0.55; // 0..1 — swing fraction within which a strike can register

// ─── Spring-back to orbit (after release / disengage) ───────────────
export const SPRING_STIFFNESS = 70; // higher = snappier
export const SPRING_DAMPING = 12; // higher = less overshoot
export const FOLLOW_LERP = 0.32; // damped follow when grabbed (higher = tighter)

// ─── Pickup + anvil collision ───────────────────────────────────────
// PICKUP_HITBOX_RADIUS: invisible sphere that catches the cursor
// for grab. Larger = easier to grab but feels less precise.
// COLLISION_PADDING: anvil bbox is inflated by this much so the
// hammer mesh — not just its origin — stays out of the anvil.
export const PICKUP_HITBOX_RADIUS = 0.95;
export const COLLISION_PADDING = 0.42;

// ─── Charge aura (lightning + halo VFX during charge) ───────────────
// SURGE_THRESHOLD: charge level above which lightning + halo render.
// AURA_MAX_BOLTS: cap on simultaneous bolts at peak.
// AURA_SEGS_PER_BOLT: how jagged each bolt is (more = more zigzag).
export const SURGE_THRESHOLD = 0.35;
export const AURA_MAX_BOLTS = 14;
export const AURA_SEGS_PER_BOLT = 6;
export const AURA_BUFFER_LEN = AURA_MAX_BOLTS * AURA_SEGS_PER_BOLT * 2 * 3;

// ─── Sparkle trail (magic dust behind the orbiting hammer) ──────────
// TRAIL_MAX_PARTICLES: array cap (oldest dropped past this).
// TRAIL_EMIT_INTERVAL_S: spawn cadence in seconds.
// TRAIL_PARTICLES_PER_EMIT: how many to spawn each tick.
export const TRAIL_MAX_PARTICLES = 120;
export const TRAIL_EMIT_INTERVAL_S = 0.022; // ~45 emissions/sec
export const TRAIL_PARTICLES_PER_EMIT = 1;
