# Contract change proposals — WP4

Append one entry per proposed change. Changes must be additive.

## 2026-09-25 — Sloped HANDRAIL variants for stair flights
- **WP:** WP4 (consumer: WP6)
- **Change:** doc comment in `core/props.ts` (no type change): "HANDRAIL variants 4..7 are the stair versions of 0..3:
  the rail is pitched by `atan(TOWER.FLIGHT_RISE / (TOWER.TREADS * TOWER.TREAD))` (= 0.3948 rad, rising toward local
  +X), so consecutive 1.2 m segments along a flight join into one continuous sloped rail. The pitched rail still fits
  inside `PROP_DEFS[HANDRAIL].size` (rail centre at 0.75 m instead of 0.9 m)."
- **Rationale:** `PropPlacement` has only a yaw, so the tower's flight handrails are currently a staircase of level
  1.2 m segments (visible in the tower screenshots). WP6 wraps variants modulo 4, so emitting variants 4..7 today would
  render as the level rails; nothing breaks before WP6 implements it. Until accepted, WP4 keeps variant 0.
- **Consumers affected:** WP6 (props/misc.ts handrail builder), WP4 (tower.ts would switch the flight rails to 4..7).

## 2026-09-25 — `vignetteCandidates` optional zone lookup (WP4-owned signature, additive)
- **WP:** WP4
- **Change:** `vignetteCandidates(seed, s, x0, z0, x1, z1, zoneAt?: (x: number, z: number) => ZoneId)` — the trailing
  parameter is optional. Without it, kinds are weighted by the storey's `STRATA_WEIGHTS` mixture of the zone columns.
- **Rationale:** the §5 table weights kinds by zone, but the frozen signature has no world access. `placeVignettes`
  passes the cell zone, so realised vignettes follow the table exactly. WP1's `findNearest('vignette:...')` pre-filter
  calls it without `zoneAt`, so its prediction can differ from the realised kind; passing
  `(x, z) => world.districtAt(s, worldToChunk(x), worldToChunk(z)).zone` would make the pre-filter exact.
- **Consumers affected:** WP1 (spawn.ts, optional improvement).

## 2026-09-25 — Tower vestibule bulb (behavioural note, no type change)
- **WP:** WP4
- **Change:** besides the two landing CAGE_BULBs, `towerPeriodSolids` emits a third, dimmer CAGE_BULB (48 cd) in the
  vestibule over the exit X (index 2: `structureFixtureId(towerId, SALT.TOWER, 2)`). It is periodic like the rest.
- **Rationale:** the tower is lit only by its own fixtures; with the landing bulbs alone the vestibule (the only part
  of the tower visible from the storey) rendered as a black hole behind the exit doorway.
- **Consumers affected:** none (consumers iterate tower fixtures by bake group).

## 2026-09-25 — Vignette spacing: 18 m candidate rule kept verbatim, realised spacing enforced at the anchor (behavioural note)
- **WP:** WP4
- **Change:** none to types. `vignetteCandidates` drops a kept candidate exactly as §5 says (lower-hash kept candidate of
  a neighbouring grid cell within 18 m). Compositions may shift their anchor up to `VIG_SHIFT_MAX` (≈ 5.0 m) from the
  candidate, so `placeVignettes` additionally rejects anchors closer than `18 m + VIG_SHIFT_MAX` to any surviving
  candidate with a lower hash (that candidate's own anchor lies within `VIG_SHIFT_MAX` of it). Such an anchor counts as
  "the local space does not fit" and the composer tries its next spot or skips the candidate. The realised
  `layout.vignettes` are then ≥ 18 m apart (acceptance) while the candidate density is the spec's.
- **Rationale:** an earlier version dropped candidates within ≈ 28 m instead, making vignettes sparser than specified.
- **Consumers affected:** WP1 `findNearest('vignette:…')` (unchanged: its pre-filter still uses `vignetteCandidates`).

## 2026-09-25 — Chalk arrows: "junction" read as a corridor junction (behavioural note)
- **WP:** WP4
- **Change:** none to types. A junction cell has ≥ 3 passable sides **and** ≥ 2 of its 4 diagonal corners unreachable in
  two steps; arrows are capped at 6 per chunk (the lowest hashes win).
- **Rationale:** read literally, every interior cell of an open LOBBY hall has 4 passable sides, so p 0.12 would put
  ~100 chalk arrows in a single open chunk. The extra corner test keeps arrows at corridor crossings and T-junctions,
  where a lost person would mark a direction.
- **Consumers affected:** none.

## 2026-09-25 — COLLAPSED_RACK is all-or-nothing (behavioural note)
- **WP:** WP4
- **Change:** none to types. The composition dry-runs the 6–10 CARDBOARD_BOX spill on a scratch placement space (on
  the floor around the rack, and some stacked on fallen boxes). It commits only if ≥ 6 boxes fit without splitting
  walkable space. Otherwise nothing is placed, the rack stays upright and the candidate is skipped.
- **Consumers affected:** none.

## 2026-09-25 — Question for the orchestrator: direction of `lerp(cct0, cct1, warmth)`
- **WP:** WP4 (affects WP2, WP3, WP5)
- **Issue:** every `LightingProfile.cctRange` is written `[low K, high K]`. Read literally, §5's
  `lerp(cct0, cct1, warmth)` gives the warmest part of the field the coldest light. That contradicts WP5's wall tint
  (warm → +R−B). WP4 (`content/fixtures.ts`) and WP3 (`zones/deepcommon.ts`) map warm → low K. WP2
  (`zones/l0common.ts:122`) follows the literal formula.
- **Proposal:** document in core/world.ts next to `cctRange`: "warmth 1 → the low-Kelvin end, warmth 0 → the
  high-Kelvin end, whatever the order of the pair". WP2 would then switch to `lerp(hi, lo, warmth)`.
