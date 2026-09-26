# Contract changes — R2 post (batch B1: camcorder post chain)

Goal: every Level 0 frame should read like the famous photo / consumer camcorder footage. The photometric chain
(nits, EV100, centre-weighted metering, hunting adaptation, per-zone EV clamps) is unchanged; this batch retunes it
and adds a few shader terms. STATUS.md rows are left to the orchestrator.

## 2026-09-25 — `ColorGrade.pedestal?: number` (core/runtime.ts, additive)
- **Change:** `interface ColorGrade { ...; pedestal?: number }`: the sensor black level in sRGB-encoded units,
  applied after the contrast curve: `e = ped + (1 - ped) * e`. Optional; absent = 0. `atmosphereBlend` copies and
  lerps it.
- **Rationale:** the lift was applied before the S-curve, and FilmGrain added zero-mean noise and then clamped at 0,
  so DARK, WAREHOUSE, CHAIR_CATHEDRAL, SERVER_ROOM and the elevator rendered p1 = p5 = 0 (pure #000). Camcorder
  blacks are lifted and noisy.
- **Values:** 0.04 for Level 0 zones (LOBBY, MANILA, MAZE, LOW_EXPANSE, PILLAR_HALL), 0.035 for OFFICE, DARK and
  the deep zones, 0.02 for POOLROOMS.
- **Consumers:** lighting/atmospheres.ts, lighting/atmosphereBlend.ts, post/effects/ColorGradeEffect.ts (uniform
  `uSatCon.z`), post/effects/FilmGrainEffect.ts (`uGrain.w`: soft noise floor at 0.25 x pedestal).

## 2026-09-25 — `AtmosphereState.flashlight?: number`, `AtmosphereState.flickerMode?: number` (core/runtime.ts, additive)
- **Change:** optional hints that LightingRuntime writes every frame: `flashlight` is 1 while the torch is on,
  `flickerMode` is 0 standard, 1 reduced or 2 off.
- **Rationale:** with the flashlight on, the meter narrows toward a spot meter on the beam
  (`AutoExposurePass.centerFocus`). The camcorder-mode fluorescent beat band respects the flicker setting: full
  amplitude for standard, half for reduced, none for off.
- **Consumers:** lighting/LightingRuntime.ts (writer), post/PostStack.ts (reader), harness/post.ts.

## 2026-09-25 — Grades: gain = 1, highlights neutral, knee, pedestal
- Every `GRADE_*` has `gain = [1, 1, 1]`. The warm/green casts moved into `gamma` and `shadowTint`. L0 uses
  gamma (1.0, 1.05, 0.9), shadowTint (0.97, 1.0, 0.9), highlightTint (1, 1, 1), contrast 1.10 (was 1.14) and
  saturation 0.95 (was 0.9).
- GRADE_FRAG: the split-tone fades to neutral above luma 0.85, and a sensor knee pulls the other channels toward
  the brightest one above 0.8 (`e = mix(e, vec3(max3(e)), smoothstep(0.8, 0.97, max3(e)))`). The
  shadow-desaturation ramp now runs to 0.65 (was 0.5) with a floor of 0.5 (was 0.6), then the pedestal is applied.
- New GRADE_MAZE: slightly warmer and dimmer than LOBBY. GRADE_MANILA is sickly green-beige: temperature −0.02,
  tint −0.08, saturation 0.8, gamma (0.95, 1.12, 0.95). GRADE_POOL is neutral: temperature 0, tint −0.02,
  shadowTint (0.98, 1, 1). The water supplies the turquoise.
- **Result:** troffer cores reach 255 in every channel (before: max 248, (234, 231, 205) at the panel core).

## 2026-09-25 — Exposure biases, EV floors, AO, grain
- exposureBias: LOBBY and MAZE 0.4 → 1.0, MANILA 0.35 → 0.9, LOW_EXPANSE 0.3 → 0.9, PILLAR_HALL 0.2 → 0.6,
  OFFICE 0.2 → 0.5, POOLROOMS 0.5 → 1.6. POOLROOMS ev100Range [8, 12.5] → [8, 13.5], haze tint (0.95, 1, 1).
- ev100Range[0] = 4 for the non-DARK Level 0 zones (LOBBY, MANILA, MAZE, OFFICE, LOW_EXPANSE, PILLAR_HALL). The
  old floors were 6.5 and 7. An unlit pocket in a NORMAL district now reads as noisy grey-brown murk instead of
  #000. The DARK zone keeps 6.5. The SPARSE, DYING and DARK moods keep their 6, 5.8 and 5.5 floors, so true
  darkness stays dark.
- aoIntensity 2.0 → 3.0 for LOBBY, MANILA, DARK, MAZE and OFFICE, and 1.8 → 2.7 for LOW_EXPANSE and PILLAR_HALL.
  AO_RADIUS 0.9 → 0.7, AO_FALLOFF 1.0 → 0.6.
- grain: 0.8 for the L0 and deep zones (was 0.5 and 0.6), 0.7 for PILLAR_HALL, 0.65 for OFFICE, 0.45 for
  POOLROOMS. MOOD_EXTRA grainMul drops from 1.2/1.35/1.6 to 1.1/1.2/1.25, because the new low-light gain supplies
  the extra noise. DESIGN table "DARK (mood)" grain is now 0.8 x 1.25 = 1.0.

## 2026-09-25 — PostStack (POST_TUNING) and effects
- Bloom: BLOOM_SCALE 0.12 → 0.35, BLOOM_RADIUS 0.75 → 0.85, BLOOM_SMOOTHING 0.2 → 0.6.
- Halation (ExposureEffect): the two coarsest bloom upsampling mips are re-added in nits, tinted (1.0, 0.85, 0.7),
  weighted 0.3 x the effective bloom intensity. This gives the wide, warm veil of a consumer lens.
- Vignette: the cos⁴ optical vignette moved from LensEffect to ExposureEffect, so it acts on HDR radiance before
  the clip. Clipped emitters near the frame edge stay white; before, they greyed to about 235. LensEffect keeps
  `uLens.z` as a residual display-side vignette, which PostStack sets to 0.
- Lens MTF (LensEffect): a 6-tap ring blur, 0.6 px at the centre to 1.4 px in the corners, mixed 70 %. Then a
  camcorder detail unsharp: amount 0.25, about 1.6 px, applied in a sqrt (gamma-like) domain. Camcorder mode only:
  a faint vertical CCD smear through clipped emitters (16 taps per column) and a fluorescent / rolling-shutter
  beat band (2.5 %, about 0.45 Hz scroll, scaled by the flicker setting).
- Grain (FilmGrainEffect): the luma noise is spatially correlated (gaussians on a 1.5 px lattice, bilinear,
  renormalised to unit variance) plus a per-pixel component. The chroma fraction rises up to 1.8x below luma
  0.15. The result is floored softly at 0.25 x pedestal instead of clamping at 0. The grain curve is calmer in
  the bright mids.
- Sensor gain (PostStack): the gain is `sqrt(sceneExposure / exposure_ref)`, where scene exposure excludes the
  zone bias and user brightness, times `1 + 0.45 * smoothstep(6.5, 4.0, EV100)`. It is clamped to
  [0.7, GRAIN_GAIN_MAX 3.5]. The chroma fraction is `0.25 + 0.3 * smoothstep(6.5, 4.0, EV100)`. GRAIN_SIGMA
  0.012 → 0.009, because correlated grain reads stronger per sigma.
- Metering: `AutoExposurePass.centerFocus` (0..1; 1 while the flashlight is on) narrows the centre weight
  toward a spot meter.
- Robustness: (a) `renderScale` divides by the device-pixel ratio that was actually applied (stored at
  construction and on `setQuality`), not by the live `devicePixelRatio`. (b) A quality change that alters
  `q.ao` or `q.aoHalfRes` builds a new N8AOPostPass. The new pass is added first, which keeps the composer's
  depth texture. The old pass is then removed and disposed, including its FullScreenTriangle quad materials,
  which `Pass.dispose()` misses. The shared depth texture is detached first, so the composer's copy survives.

## 2026-09-25 — Lighting runtime
- Flashlight: CD 600 → 2000, ANGLE 0.45 → 0.35, PENUMBRA 0.6 → 0.45, aim convergence 6 m → 3 m
  (`FLASHLIGHT.CONVERGE`).
- Far colour: `farColor = meanIrradiance · albedo/π · hazeTint · FAR_FRACTION · FAR_WARM`. `meanIrradiance` is the
  camera irradiance smoothed over 3 s. FAR_FRACTION changed 0.3 → 0.14, and FAR_WARM = (1.0, 0.9, 0.74). The
  streaming edge (quality=low: about 31 m) now falls into a warm, darker gloom instead of a flat grey-green wall.

## 2026-09-25 — QA thresholds (§8.2, tools/qa.mjs, harness/post)
- `lit.clippedMax` 0.03 → 0.08, because panels and skylights now clip like a real camera. Dark classes keep 0.03.
  The post harness still requires < 3 % clipped outside the emitters.
- The post harness bloom check is tightened to `ringOn > 1.25 x ringOff` (was 1.05). Measured: 1.49.
