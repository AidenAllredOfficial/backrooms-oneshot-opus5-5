# R2 content — lived-in Level 0 (batch B6)

Goal: a small moment every 20-40 s of walking and surfaces that look abandoned rather than empty. No new ids, no
`core/*` changes (existing PropKinds, DecalKinds, SignKinds, TileStates, SALTs only). Files: `world/content/`
vignettes, anomalies, props, leaks, signs, occupancy; tests `tests/world/content.test.ts`, `tests/world/coverage.test.ts`.

Measured with the pure generator over seeds 1-6, 16 x 16 chunks x 3 storeys (4,608 chunks):

| Quantity | WP4 | R2 |
|---|---|---|
| Vignettes / km², storey 0 / 1 / 2 | 481 / 396 / 267 | 1,423 / 1,366 / 831 |
| MATTRESS_CLOSET / BACKPACK_CAMP | 0 / 0 | 183 / 544 |
| REPEATED_ROOM / CEILING_FURNITURE | 0 / 6 | 28 / 51 |
| Traces (L0 family): m² of LOBBY floor per trace | none | 92 (DARK / MAZE 68, OFFICE 119, LOW_EXPANSE 201, PILLAR_HALL 477) |
| Props / 100 m² LOBBY, PILLAR_HALL, LOW_EXPANSE | 3.0, 0.12, 0.70 | 4.6, 0.55, 1.7 |
| L0 ceiling tiles NORMAL / STAINED / DIRTY / NEW / SAGGING / MISSING | 90.8 / 1.4 / 0 / 0.4 / 0.3 / 1.4 % | 80.0 / 4.0 / 5.5 / 2.2 / 0.9 / 1.7 % |
| WET share of humid (> 0.6) DARK / MAZE / OFFICE / LOW_EXPANSE floor | ~2 % | 6.7-6.8 % |

## Vignette density (vignettes.ts)

`VIG_GRID` 18 -> 11 m, `VIG_KEEP_P` 0.45 -> 0.6, `VIG_MIN_SPACING` 18 -> 10 m (`VIG_DROP` = grid pitch). The realised
spacing rule is unchanged (anchor >= spacing + shift from every prior candidate). About 3x the moments.

## Compositions that never fitted

- **BACKPACK_CAMP**: the sleeping bag's long axis is its local Z; WP4 used `yawOf(tz, tx)` (across the wall), so the
  2 m bag always hit the wall. Now `yawOf(tangent)`, both flips, three slides along the wall, then perpendicular
  (head at the wall). Backpack at the head end (fallbacks beside it), 2-4 bottles, a box with a bottle on it, papers,
  tally marks. Bottles and the backpack may use keepClear cells (small, no collision).
- **MATTRESS_CLOSET**: LOBBY "rooms" are huge, so a 2-6 cell room never existed. The closet now carves its own 2x2 /
  2x3 pocket into a room corner (>= 2 sides already WALL, else >= 1; the other sides all OPEN): open sides become
  WALL (the cell's `wallMat`, baseboard trim copied), one DOORWAY (head `min(210, ceiling - 10)`, CASING), a
  `DOOR_LEAF` swung 55-75 degrees into it (collision snaps open along the jamb), a mattress against a closet wall,
  1-2 bottles, a paper, and one bare `CAGE_BULB` (2500-2900 K, 120-160 cd, 25 % DYING; QA `dead` -> OFF). Guards:
  cells dry open floor at one height, no keepClear / LANDMARK / ARTERY / WET, no props or solids inside, no fixture
  straddling or touching the new walls (fixtures fully inside are removed, their FIXTURE tiles reset), the door
  approach free of props / solids, and every cell reachable from the ports before stays reachable (else reverted:
  `occupancy.ts EdgeEdits`, `portReach`). Rooms are re-labelled (`labelRooms`) and keepClear is extended around the
  door. Falls back to an existing 2-6 cell room.
- **FALLEN_TILES** on storey 1 (Level 0 districts there have concrete slabs): a spalled-ceiling heap
  (`CEILING_DEBRIS`, a DRIP emitter, a water stain) instead of nothing.

## Anomalies (anomalies.ts)

- `REPEATED_ROOM_P` 0.02 -> 0.04. Natural pairs first; otherwise `stampRoomPair` stamps two equal 5 x 6 rooms joined
  along x or z in open LOBBY / MANILA floor: interior edges cleared, every boundary edge rewritten to WALL except three
  DOORWAYs in one line (A's outer wall, the shared wall, B's outer wall: an enfilade in which the same room is seen
  twice), middle rows preferred so the door strips stay off the long walls. Guards as for closets plus: no vignette
  anchor within 1 m of the region, no DOOR_LEAF within 1 m, neither room crossing a render-tile line, candidates
  ranked by the number of fixtures to remove. Room A is emptied and furnished (desk + CRT + office chair pushed back
  + bin on one long wall; filing cabinets, a water cooler, boxes and a stacking chair facing the wall on the other;
  papers) with A's keepClear united with B's, then `repeatRoom` copies it. `repeatRoom` now also refuses a pair
  whose copied recessed fixtures would straddle a render-tile line in B.
- `syncRepeatedRoom(l)` (called at the end of `placeLeaks`) re-copies A's ceiling tiles and WET flags to B after the
  tile ageing, damp cells and leaks that run later.
- `CEILING_FURNITURE_P` 0.01 -> 0.03. Where no furniture pair within 6 m of each other in one room exists (LOBBY),
  `chairRing` sets out 4-6 stacking chairs in a ring facing inward (a meeting nobody attended) and that ring is
  mirrored onto the ceiling.
- Verify pass: only group members with a >= 2.3 m ceiling and no fixture within 1 m are mirrored, so a loose LOBBY
  "group" (for example a stray chair 6 m from an office chair under a troffer) often left a single chair on the
  ceiling. Level 0 chunks now set out the ring whenever fewer than two pieces can be mirrored. The ring also tries
  spots with no fixture within 2.2 m of its centre first. Seeds 1-7, storey 0, 10 x 10 chunks: 4 single-chair sites
  before, 1 after.

## Trace layer (props.ts `placeTraces`, run at the end of `placeVignettes`)

Per 8x8 window of Level 0 floor (not keepClear / LANDMARK / RESERVED): `n = floor(area / TRACE_M2 * zoneW * (0.4 +
1.2 * decay) + u)`, `TRACE_M2 = 45`, zone weights LOBBY 1, MANILA 1, DARK 1.1, MAZE 0.8, OFFICE 0.6, LOW_EXPANSE 0.3,
PILLAR_HALL 0.25. Traces keep 3.2 m from each other and 3 m from vignette anchors. Kinds (weights lerp from decay 0
to 1): stray stacking chair(s) (10 -> 6), office chair adrift (4 -> 2), scattered papers (+ box / bottle) (9 -> 7),
boxes against a wall, sometimes stacked (8 -> 5), wet patch with a stain, wet footprints and maybe a bucket (3 -> 9),
bucket with the mop standing in it or leaning beside (4 -> 4), bin with bottles and papers (4 -> 7), one fallen tile
(tile MISSING, fragments below) (2 -> 8), a spare door leaf propped against a wall (1 -> 2), bottles at a wall base
(3 -> 6), stack of 3-7 nested stacking chairs (3 -> 2). Floor paper decals use a yellowed linear tint
(`PAPER_TINT` 0.74 / 0.69 / 0.55) so they read as old paper, not white sprites. rng: `rngFor(seed, SALT.PROP, s, cx,
cz, 0x7ace)`.

## Storage clusters (props.ts `placeDistrictClusters`)

PILLAR_HALL / LOW_EXPANSE districts stay sparse, but the chunk containing the district site gets one big cluster and
other chunks of the district a medium one with p 0.22: pallet stacks (1-8 high, boxes on top, loose pallets),
a wall of boxes (2 rows, 1-4 high), rows of nested stacking-chair stacks (3-11 high, loose chairs), or desks pushed
together with chairs stacked on them and a filing cabinet. Wall-backed anchors first, free-standing ones in the open
(distance >= 2.7 m) otherwise; planned on a scratch placement space and committed only if enough bases fit.

## Ceiling tile ageing and damp floors (leaks.ts)

`placeLeaks` now runs `ageCeilingTiles`, `placeDampCells`, the WP4 leak sites (`placeLeakSites`) and
`syncRepeatedRoom`.

- `agedTileState(seed, s, ti, tj, decay, humidity)`, hashed per global 0.6 m tile with `SALT.TILE_STATE`, only for
  NORMAL tiles of TILES ceilings (FIXTURE / VENT / other states untouched; SOLID, TOWER, ELEVATOR, NO_CEIL, LANDMARK
  cells skipped). Base rates `TILE_AGE_P`: NEW 2 %, DIRTY 6 %, STAINED 3 %, SAGGING 0.7 %, MISSING 0.3 %; per cell
  MISSING x (0.3 + 1.4 decay), SAGGING x (0.2 + 1.6 humidity), STAINED x (0.3 + 1.4 humidity), DIRTY x (0.4 + 1.2
  decay), NEW x (1.6 - 1.2 decay); water damage clumps per 2.4 m tile block (factor 3v², mean 1), grime per block
  (0.3 + 1.4v, NEW gets the complement) so damaged tiles come in patches. Rates equal the targets at decay = humidity
  = 0.5 (tested).
- Damp cells: humid (> 0.6) Level 0 floor gets 1-4-cell WET patches with a faint WATER_STAIN, dampest cells first
  (hash / humidity excess), until `DAMP_TARGET` = 5.5 % of the chunk's humid cells are WET (wet cells from other
  passes count, so already flooded chunks get none). LOBBY and MANILA chunks were already above that through other
  passes (12 % / 22 % mean, concentrated in a few chunks).

## Wayfinding (signs.ts)

`placeExitSigns(ctx, { dark?, stairs? })` (both default on):
- **STAIRS signs**: wall faces within 30 m (and >= 4 m) of a tower exit whose wall runs toward the exit (|dot| >= 0.6
  and the passage continues that way) get, with p 0.12 per face hash, <= 3 per chunk, >= 8 m apart, a blue STAIRS
  plate (0.3 m, 1.55 m high) and a stencil ARROW_UP plate beside it rotated to point along the wall toward the tower
  (wall decal rot -pi/2 = viewer's right).
- **Dark rooms**: DOORWAY / HEADER edges with unlit cells (no lit fixture within 4.5 m) on both sides get an
  EXIT_SIGN fixture over the opening (p 0.3 per edge, <= 2 per chunk, not within 3 m of another EXIT sign), facing
  the side away from the nearest tower (read while walking toward it). Pockets of lit districts only: the DARK zone
  itself stays black (the spawn view into it looks for no emitters). QA `on`: none; `dead`: OFF.

## Not possible without other batches

- A tipped-over chair, a ceiling tile leaning on a wall, a mattress on its side: `PropPlacement` has yaw only (no
  roll / pitch) and there are no tipped variants in `src/props` (not owned by any batch). A `PropFlag.TIPPED` bit or
  variants 4+ would enable them.
- Extension cord, unplugged fan, clipboard, paper cup: no PropKinds (ids are B4's `core/ids.ts`); bottles and paper
  decals stand in.
- STAINED tiles render only as a slight warm tint (`mesh/ceilings.ts`); B3 owns a stronger stain look.
