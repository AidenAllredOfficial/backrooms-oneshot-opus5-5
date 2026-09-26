# Contract change proposals — WP1

(none yet — see TEMPLATE.md)

## 2026-09-24 — createChunkGrid needs the world seed
- **WP:** WP1
- **Change:** `export function createChunkGrid(layout: ChunkLayout, seed: number): ChunkGrid & { freezeSeams(): void; setSeam(side: 'W' | 'N' | 'E' | 'S', s: SeamSpec): void };`
  (additive alternative: `seed = 0` as an optional second parameter).
- **Rationale:** `ChunkGrid.addFixture(f, { latticeI, latticeJ })` must produce `id = fixtureId(seed, s, latticeI, latticeJ, f.kind)`
  (core/world.ts, DESIGN §5 WP1 "ChunkGrid implementation notes"), but `createChunkGrid(layout)` gets no world seed and
  `ChunkLayout` does not carry one. The same applies to the seeds of `addEmitter` / `addVignette` / `addAnomaly`
  (`AudioEmitterSpec.seed`, `VignetteInstance.seed`, `AnomalySite.seed`). WP0 stub workaround: lattice-keyed ids use
  seed 0 (unique per location but seed-independent); the grid test scene passes explicit `{ id, seed }` keys.
- **Consumers affected:** WP1 only (chunkgen.ts, testScenes.ts create grids); WP2/WP3/WP4 receive the grid via `ZoneGenContext`.

## 2026-09-24 — LayoutNeighborhood.fixturesNear semantics (clarification)
- **WP:** WP1
- **Change:** doc comment only: "`out` is cleared first; returns `out.length`. Fixtures of neighbour chunks are copies
  translated into centre-chunk-local coordinates (cached per neighbourhood); centre-chunk fixtures are the originals."
- **Rationale:** the contract does not say whether `out` is appended to, nor that neighbour fixtures' `px/pz` (stored in
  their own chunk's local frame) must be translated.
- **Consumers affected:** WP5, WP6, WP7.

## 2026-09-24 — WorldGenQuery.towersNear / elevatorsNear / arteriesNear radius (doc comment)
- **WP:** WP1
- **Change:** doc comments only, in `core/world.ts`:
  - `towersNear(s, cx, cz)` / `elevatorsNear(s, cx, cz)`: "sites whose chunk is within Chebyshev distance 2 of
    (cx, cz) (storey-independent; `s` is accepted for symmetry), in super-region row-major order".
  - `arteriesNear(s, cx, cz)`: "artery spans (one per 8-chunk segment) crossing any of the 3x3 chunks around (cx, cz)".
- **Rationale:** the contract gives no radius. WP4 exit signs need "within 2 chunks of a tower" and chalk arrows point
  at "the nearest tower exit"; WP2/WP3 need the spans that cross their chunk. Implemented as above in
  `src/world/sites.ts` (`SITES_NEAR_RADIUS = 2`).
- **Consumers affected:** WP2, WP3, WP4 (no code change needed).

## 2026-09-24 — Onboarding "world origin" (clarification of §5 WP1 algorithm 1)
- **WP:** WP1
- **Change:** spec text only: "sort by distance to the world origin" means the *warped* centre of chunk (0, 0), i.e.
  the same point the nearest-site test uses for the origin chunk.
- **Rationale:** with the raw origin (0, 0) the district that actually contains chunk (0, 0) (the spawn) can differ
  from rank 0 whenever the warp moves the origin chunk across a Voronoi border, so the spawn would not be in the
  onboarding LOBBY. With the warped point, rank 0 is exactly the spawn district (tested for 40 seeds).
- **Consumers affected:** none outside WP1.

## 2026-09-24 — Hard-boundary style precedence for open zones (clarification of §5 WP1 algorithm 3)
- **WP:** WP1
- **Change:** spec text only. `styleFor` says PARKING/WAREHOUSE → roll-up (HEADER, 3–4 cells, `EdgeTrim.ROLLUP`),
  but both zones are `ZONE_INFO.open`, and the "open zone → 4–8-cell openings of the open zone's kind" rule would
  turn every such boundary into plain OPEN gaps, so the roll-up style (and WP5's METAL_PAINTED header box) could
  never appear. Implemented precedence: (1) PARKING or WAREHOUSE involved → roll-up, 3–4 cells, underside
  `clamp(minCeil − 30, 220, 300)` so the box fits under the ceiling; (2) otherwise, either zone open → 'wide'
  4–8-cell openings (ARCH when POOLROOMS is involved, else OPEN); (3) otherwise `styleFor` (arch / doorway / header).
- **Rationale:** keeps every style in the table reachable; tested in `tests/world/seams.test.ts`.
- **Consumers affected:** none (WP5 already handles HEADER + ROLLUP).

## 2026-09-24 — testScene=materials prop gallery and `lights` override for test scenes (implementation note)
- **WP:** WP1
- **Change:** none to contracts. `testScene=materials` now calls `grid.addProp` once for every PropKind along the
  west/east gallery walls (§5 WP6 screenshot requirement; SHELF_RACK scaled to fit under 2.7 m). `lights=on|dead`
  is applied to test-scene layouts too (generated chunks get it from WP4 `assignFixtureStates`).
- **Consumers affected:** WP6 / WP14 screenshots.

## 2026-09-24 — Soft/hard boundary decided per district pair (clarification of §5 WP1 algorithm 3)
- **WP:** WP1 (auditor)
- **Change:** spec text only. The 40% soft draw is `hash01(hash5(seed, SALT.SEAM, s, min(idA, idB), max(idA, idB))) < 0.4`
  (order-independent, one decision per DISTRICT PAIR) instead of `rng.chance(0.4)` on the per-seam rng. The rest of the
  seam (pattern runs, hard openings) still uses the per-seam rng.
- **Rationale:** the acceptance criterion is stated per pair ("soft BOUNDARY seams are 40% ± 5% of eligible district
  pairs"), and a per-seam draw made one district boundary alternate between hard walls with styled openings and soft
  mostly-open stretches, which reads as random gaps in the boundary wall. Tested in `tests/world/seams.test.ts`
  (every seam of a pair agrees; 40% ± 5% over pairs).
- **Consumers affected:** none (seams stay pure and identical on both sides).

## 2026-09-24 — Unreachable components that hold a port cell (clarification of §5 WP1 algorithm 6, step 4)
- **WP:** WP1
- **Change:** spec text only. Step 4 ("< 3 cells → SOLID; otherwise SEALED") skips components that contain a port
  cell (inner cell of a walkable seam edge). Such a component is reached from the neighbour chunk through the frozen,
  shared seam, so turning it SOLID would leave a walkable seam edge facing a solid cell (validateLayout: "port cell
  not walkable") and flagging it SEALED ("heard, not entered") would be wrong. It is left untouched.
- **Rationale:** the literal rule can break cross-seam walkability whenever a port pocket cannot be carved to main
  (frozen/reserved cells in the way). Tested in `tests/world/connectivity.test.ts`.
- **Consumers affected:** none.

## 2026-09-24 — labelRooms floods non-SOLID cells (clarification of §5 WP1 algorithm 7)
- **WP:** WP1
- **Change:** spec text only. `labelRooms` floods every non-SOLID cell (as the `ChunkLayout.room` doc comment says:
  "0 = none (solid)"), not only walkable ones, so deep pool water, VOID pit cells and blocker cells get the room label
  of the space they are in.
- **Rationale:** `room` is used only for WP7 probe interpolation and acoustics; a pool or a pit is lit by, and sounds
  like, the room around it. Labelling them 0 would make WP7 treat them as solid.
- **Consumers affected:** WP7 (no code change needed).

## 2026-09-24 — Seam BASEBOARD trim between two palettes (clarification of §5 WP1 algorithm 3, post-rule 4)
- **WP:** WP1
- **Change:** spec text only. "`trim` gets BASEBOARD if the palette has one" is read as "if BOTH palettes (A and B)
  have one": edge trim is a single flag per edge, and a baseboard strip on a POOLROOMS tile or bare CONCRETE face
  looks wrong.
- **Consumers affected:** WP5 (renders the flag on both faces).

## 2026-09-25 — forceLandmark keeps chunk (0, 0) free of towers / elevators (clarification of §5 WP1 algorithm 4)
- **WP:** WP1 (auditor)
- **Change:** spec text only. With `forceLandmark` set, a tower or elevator site whose chunk would be (0, 0) is rejected
  and retried (same retry scheme as the artery-lane rejection). Without it the origin tower (chunk `(h%2, (h>>1)%2)`)
  lands in chunk (0, 0) for ~25% of seeds and the forced landmark stamp overlaps it. Worlds without `forceLandmark`
  are unchanged.
- **Consumers affected:** none (QA / screenshot runs only).

## 2026-09-25 — Seam DOORWAY edges get CASING (clarification of §5 WP1 algorithm 3, post-rule 4)
- **WP:** WP1 (auditor)
- **Change:** spec text only. `SeamEdges` carry no trim, so DOORWAY edges on PATTERN / GLOBAL seam lines (e.g. OFFICE
  global seams) now get `EdgeTrim.CASING` in post-rule 4, matching the interior doors generators write.
- **Consumers affected:** WP5 (renders the casing; no code change).

## 2026-09-25 — ASCII vertices print '+' only next to a non-OPEN edge (clarification of §5 WP1 item 9)
- **WP:** WP1
- **Change:** spec text only. `layoutToAscii` prints `+` at a vertex when at least one of its four adjacent edges is not
  OPEN, and ` ` when all four are OPEN. The spec says "Vertices: `+`" without qualification.
- **Rationale:** a `+` on every vertex covers large open zones (PILLAR_HALL, PARKING, WAREHOUSE, LOW_EXPANSE) in a
  uniform lattice, so walls and openings are hard to read in `tools/map.ts` output. `layoutFromAscii` ignores vertex
  characters, so the round-trip test and every test scene parse the same either way. Documented in the
  `src/world/ascii.ts` header.
- **Consumers affected:** none (no other module parses `layoutToAscii` output; test helpers in other WPs build their
  own ASCII).

## 2026-09-25 — findSpawn prefers the origin district (clarification of §5 WP1 item 8)
- **WP:** WP1
- **Change:** spec text only. `findSpawn(s)` first scores only the SPAWN_OK cells of the 3×3 origin chunks that lie in
  the district containing chunk (0, 0). It falls back to all nine chunks only when that district has no SPAWN_OK
  cell. Scoring, yaw and tie-breaking are as specified.
- **Rationale:** on storey 0 the district containing chunk (0, 0) is onboarding rank 0, the LOBBY that D13 describes
  as the spawn composition. Scoring all nine chunks could put the spawn in a neighbouring onboarding district
  (e.g. PILLAR_HALL) because of its long sightlines, and the player would not start in the famous-photo LOBBY.
- **Consumers affected:** none (WP8/WP14 only read the returned SpawnPoint).
