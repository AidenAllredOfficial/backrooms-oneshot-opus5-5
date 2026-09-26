# R2 lighting — baked lighting and fixture photometry (batch B2)

Goal: "flat but not uniform" light (bright pools under fixtures falling off into gloom, mismatched tubes, no
black voids in normal districts) and a photographic sun in the Poolrooms, keeping the leak-free soft-penumbra bake.
No new ids; `core/*` untouched.

## Fixture photometry (world/content/fixtures.ts, lattice placement)

| Quantity | Before | Now |
|---|---|---|
| Luminance scatter | `L * (1 +- 0.06)` uniform | `L * exp(0.18 * g)`, g ~ N(0,1) (Irwin-Hall of 4 hashes; `expPoly` Taylor exp, pure arithmetic so layout hashes stay engine-exact) |
| CCT | `lerp(hi, lo, warmth)` | same + per-fixture jitter +-350 K (tube batches) |
| Green tint (`kelvinToLinearRGB` 2nd arg) | 0.02 .. 0.05 | 0.02 +- 0.03 (-0.01 = slightly magenta .. 0.05 green) |
| One lamp pair out | — | 7% of 2x4 troffers become two 0.6 x 0.6 records on the troffer's two tiles: one emits (same nits), the other has luminance 0 and is forced OFF (grey lens). Each half keeps its own lattice key / id. |

Helpers exported: `expPoly`, `gaussOf`, `fixtureScatter(h)`, `LUM_SIGMA`, `CCT_JITTER`, `TINT_BASE/SPAN`,
`HALF_OUT_P`. Custom placers (deep zones, B5's `lumJitter`) are unchanged by this batch.

## Emitter distribution (bake/areaLight.ts, bake/lights.ts)

Troffers (`TROFFER_2x4`, `TROFFER_2x2`: `LightSet.lens = 1`) are no longer ideal Lambertian: prismatic lens
`I(theta) ~ cos^1.5(theta)`, normalised by `(n + 1) / 2 = 1.25` (flux unchanged), i.e. every emitter-side cosine is
multiplied by `lensW(ce) = 1.25 * sqrt(ce)` (n = 1.5 instead of 1.4: `sqrt` instead of `pow` in the hot loop).

- point / 2-point samples: per-sample weight;
- exact polygon (d < 3 x size): below `LENS_SPLIT0 = 1.0 x size` the rectangle is split into 4 x 2 sub-rectangles
  (each exact, weighted at its centre); between 1.0 and 1.5 x size a smoothstep blend to the whole polygon weighted
  at its clipped centroid direction; beyond that the latter (continuous everywhere, tested);
- `tailSum` (K_MAX tail) applies the same weight.

Effect: directly below a troffer E is ~25% higher, the ceiling and the upper wall right next to a fixture receive
2-3x less, mid-walls between fixtures fall off: visible scallops / pools. All consumers of `formFactor` (texels,
patches/probes, light volume, flicker channels) change together. `tests/bake/analytic.test.ts` now integrates the
lens-weighted rectangle numerically (still 2% / 10%); a new continuity test checks that the method switches never
kink.

## AO (bake/ao.ts)

Wall faces are accumulated per wall line (axis + line index, the receiver sees one side): the minimum distance over
the line's cell segments multiplies once. The per-segment product double-counted receivers near every segment joint
(the 1.2 m-periodic lumpy band along ceiling-wall junctions). Regression: `tests/bake/ao.test.ts` (uniform within
0.5% along a 10-cell wall; the old code gave a 1.64 max/min ratio).

## The sun (bake/lights.ts `gatherSun`, bake/direct.ts `sunAt`, bake/patches.ts)

- Apertures: lit `SKY_PANEL` fixtures of a `SKYLIGHT_HALL` landmark (from the 9 layouts), rasterised into an exact
  half-cell bitmap per aperture-plane height (panels lie on the 0.6 m lattice). `BakeJob.sun` (null elsewhere: no cost).
- One world-fixed sun: elevation 56 deg, azimuth 35 deg (from +x toward +z), E = 32 klux x glazing 0.6 normal to the
  beam, colour (1, 0.93, 0.84). Tuned with the skylights (below) so the hall stays inside the Poolrooms EV range with
  patches ~3x the ambient floor irradiance (25 klux x 0.6 was the brief's starting point).
- Texels (full bake): 8 directions jittered over a 0.006 rad square (~13 cm penumbra at 11 m), Cranley-Patterson
  rotated by the quantised world position; aperture test per direction, DDA occlusion for the first and last glazed
  directions (all of them when those disagree). Preview: 1 direction, 1 ray. Penumbra texels are denoised like
  shadow-sampled texels. Adds to the static RGB and the dominant-direction accumulator.
- Patches (probe bounce): 4 points per patch, centre direction, 1 ray each, so sun patches bounce.
- Pure function of world position (seam-exact; `tests/bake/sun.test.ts` compares two tiles).

## Skylight hall (world/landmarks/skylightHall.ts)

Panels 4 x 3 skylights of 1.8 x 2.4 m (19% of the ceiling, was 5 x 4 = 62%), 11500 nits (was 4000): the hall reads
as sky + sun instead of an evenly glowing ceiling. Verification pass: 3.0 x 2.4 m panels at 7000 nits rendered the
glazing at ~230/255 (a light grey grid) at the hall's EV ~12.7. Shrinking the panels to 60% of that area and raising
them to 11500 nits keeps the same sky flux (7000 x 240 tiles ~ 11500 x 144), so the exposure did not move (EV 12.6),
and the glazing now renders at 240-246/255 with narrower, crisper sun shafts. `tests/bake/sun.test.ts`: the sunlit
floor fraction lower bound is 5% (was 10%); the measured value is 8%, because part of each beam lands on the walls.

## Fixture states (world/content/fixtureStates.ts)

- luminance-0 fixtures (dead troffer halves) are OFF (QA `lights=on` keeps them ON; they emit nothing);
- HIGHBAY that comes out ON is OFF with p 0.17 (HID lamps);
- OFF cap: outside the DARK zone / DARK mood, at most 70% (DYING mood: 85%) of the adjustable fixtures of any
  8 x 8-cell window are OFF; the OFF ones with the highest u become DYING (FLICKER with p 0.25, then the dynamic rule);
- emergency lights (`placeEmergencyLights`, fixtures.ts): a cell is lit when a lit fixture is within reach (ON 6
  cells, FLICKER 5, DYING 4; exit signs do not count) and in line of sight on the cell grid (walls / windows block;
  open edges, doorways, arches, headers, low partitions pass); cells within 2 of the chunk border count as lit. While
  dark cells remain, the dark cell whose bulb (reach 4) lights the most dark cells (>= 6) gets a 38 cd 2700-3200 K
  CAGE_BULB 14 cm under its ceiling (max 6 per chunk; landmark cells excluded). About 1.6 per LOBBY chunk, 0 in the
  DARK zone / mood. The greedy keeps a gain per candidate and recomputes it only within 2 x reach of a placed bulb.
  The output is identical to a full rescan (checked on 320 chunks). The whole rule costs about 1 ms per chunk.

## Zones

- WAREHOUSE: HIGHBAY rows over the centre line of every rack aisle (2-cell aisles and 5-cell main aisles), 7.2 m
  apart, staggered on alternate aisles, 7.0 m high, 3200 cd, 4000-5000 K (was one every 12 m, 2000 cd:
  47% of the floor > 7 m from a lit fixture). SPARSE / DARK moods: every other aisle, 12 m apart. (The optional
  emissive roof-deck skylights were not done: they need mesh support.)
- MAZE: troffers 2800 nits (was 3300), CCT 3300-3700 K (was 3700-4600): warmer and dimmer than LOBBY.

## Bench (tools/bakebench.ts --no-ttr, quality high, full-bake mean ms per tile; shared, noisy machine)

| Zone | Before | After (same load) | Rays / tile before -> after |
|---|---|---|---|
| LOBBY | 400 | 432 | 749k -> 761k |
| LOW_EXPANSE | 302 | 351 | 484k -> 490k |
| PILLAR_HALL | 360 | 405 | 692k -> 721k |
| POOLROOMS (vaulted) | 347 | 373 | 627k -> 629k |
| WAREHOUSE | 169 | 283 | 194k -> 446k (37 -> 131 lights: the new aisle high-bays) |
| ATRIUM | 427 | 441 | 856k -> 873k |

Interleaved A/B of the lens alone (LOBBY, lens off/on/off/on): 464 / 500 / 479 / 487 ms, i.e. ~+5%. The rest is
machine load (a later run under load average 8 measured every zone, including untouched ones, +20%) and, in the
WAREHOUSE, the 3.5x light count. The sun costs nothing outside SKYLIGHT_HALL neighbourhoods (`job.sun` null).

## Test / golden impact (other owners)

- `tests/world/golden.json`: layout hashes change (fixtures, states, emergency bulbs, warehouse, maze, skylight hall).
- `tests/world/content.test.ts` (B6): "luminance within +-6%" and the tint range assume the old uniform jitter; the
  state-mix test must skip luminance-0 halves / emergency CAGE_BULBs and account for the OFF cap.
