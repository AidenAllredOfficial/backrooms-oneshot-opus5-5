# Contract change proposals — WP3

## 2026-09-25 — WorldGenQuery: expose elevator and landmark sites to zone generators
- **WP:** WP3
- **Change:** in `src/core/world.ts`, add two read-only queries to `WorldGenQuery` that the `WorldGen` facade already
  implements (so this is additive, and WP1 needs no code change: `ctx.world` is already the facade):
  ```ts
  export interface WorldGenQuery {
    districtAt(s: StoreyId, cx: number, cz: number): DistrictInfo;
    arteriesNear(s: StoreyId, cx: number, cz: number): readonly ArterySpan[];
    towersNear(s: StoreyId, cx: number, cz: number): readonly TowerSite[];
    elevatorsNear(s: StoreyId, cx: number, cz: number): readonly ElevatorSite[]; // NEW (moved up from WorldGen)
    landmarkAt(s: StoreyId, cx: number, cz: number): LandmarkSite | null;       // NEW (moved up from WorldGen)
  }
  ```
- **Rationale:** GLOBAL-seam zones build world-anchored features that cross seams. Both chunks must make the same
  decision about them, so each needs to know which stamps the *other* chunk will contain. Arteries and towers can be
  queried today; elevators and landmarks cannot. Examples are POOLROOMS channels into a pool in the neighbouring chunk
  (the pool is dropped there when a stamp overlaps it, which leaves a dead-end channel) and the stamp aprons used by
  PARKING and WAREHOUSE.
  **Workaround in place:** `src/world/zones/deepcommon.ts` (`elevatorsNear`, `chunkHasLandmark`) reads both methods
  from `ctx.world` by duck typing and falls back to "no sites" when they are absent (mock worlds in tests). If this
  change is accepted, the cast can simply be removed.
- **Consumers affected:** WP1 (the facade already satisfies the widened interface). Test mocks of `WorldGenQuery` in
  tests/world/* would need two stub methods (`() => []`, `() => null`). WP3 and WP4 (landmarks/content) can use them.

## 2026-09-25 — Spec clarification (no code contract): WAREHOUSE rack row length
- **WP:** WP3
- **Change:** DESIGN.md §5 WP3 WAREHOUSE says "rows 10–20 cells long, a cross-aisle every 16 global cells". Those two
  rules contradict each other: a 2-cell cross-aisle every 16 cells leaves at most 14 cells between aisles, so a row
  longer than 14 would have to cut through an aisle. The implementation keeps the aisle lattice (the layout rule you
  can see and navigate by) and uses rows of 10, 12 or 14 cells, flush with one of the two aisles of their 16-cell block.
  Proposed wording: "rows 10–14 cells long (up to the 16-cell cross-aisle pitch)".
- **Rationale:** the two rules cannot both hold, so the spec needs to pick one.
- **Consumers affected:** none (text only).
