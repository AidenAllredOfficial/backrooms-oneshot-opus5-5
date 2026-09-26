# Contract change proposals — WP2

(none yet — see TEMPLATE.md)

## 2026-09-24 — DARK zone "decay +0.2" has no carrier in LightingProfile / FieldSampler
- **WP:** WP2
- **Change:** add an optional field to `LightingProfile` (src/core/world.ts):
  ```ts
  decayAdd?: number; // added to fields.decay(x, z) (clamped to [0, 0.999]) wherever this profile applies; DARK: 0.2
  ```
- **Rationale:** the §5.WP2 palette table gives DARK `zoneMul 0.35, decay +0.2`. `zoneMul` exists in LightingProfile,
  but nothing carries a decay offset. `FieldSampler` is built per storey by WP1 (`createFieldSampler(seed, s)`), and WP4
  (`assignFixtureStates`, `placeProps`, `placeDecals`) reads `ctx.fields.decay` directly. A zone generator therefore
  cannot raise decay for its district. Until this lands, WP2 applies the offset only inside its own generate()
  (a wrapped sampler for its own placement decisions), so fixture states and props in DARK districts do not get it.
- **Consumers affected:** WP1 (chunkgen passes a wrapped FieldSampler in ctx.fields when `decayAdd` is set), WP4
  (no change if WP1 wraps ctx.fields), WP2 (lobbyGenerator.lighting returns `decayAdd: 0.2` for DARK).

## 2026-09-24 — Spec clarifications for §5.WP2 acceptance (no code contract change)
- **WP:** WP2
- **Change:** documentation only (DESIGN.md §5.WP2 "Acceptance" and "Algorithms"); nothing in `src/core/*` changes.
  1. **Walkable fraction: definition and LOBBY-family band.** Define the measure as
     `(walkable cells / 1024) × (passable interior adjacencies between walkable cells / all interior adjacencies
     between walkable cells)`. Walkable = WP1's cell rule; passable = `EDGE_WALKABLE` (HEADER only with hA ≥ 190).
     Change the band for LOBBY / MANILA / DARK from 55–85 % to **55–90 %**. MAZE (55–85 %), LOW_EXPANSE /
     PILLAR_HALL (≥ 85 %) and OFFICE (≥ 60 %) keep their bands. This is the definition in
     `tests/world/zones-l0.test.ts` `walkableFraction()`.
  2. **Narrow MAZE chambers.** The narrow variant also opens 4 node-aligned chambers (5×5 to 7×7 cells) per chunk.
  3. **LOBBY DOORWAY openings are 1 cell wide.** OPEN and HEADER openings use widths 1/2/3 (0.4/0.4/0.2).
     Openings on a wall line keep ≥ 1 wall edge between them and together take at most ⌈segment/2⌉ edges, so a
     short wall is still a wall. An opening that doesn't fit is dropped.
  4. **Unspecified lighting values** (implementer's choice; the table gives none):
     - MAZE: TROFFER_2x4 at 3300 nits, 3700–4600 K (as LOBBY).
     - LOW_EXPANSE: 3700–4600 K.
     - PILLAR_HALL: pendants at 4200 nits (reading the table's "4200" as luminance), 3800–4400 K.
     - Storey-2 SKY_PANEL lattice: 6×6 tiles.
  5. **Feature-room DOORWAY head** (LOW_EXPANSE): `min(DOOR_CM, ceilCm − 10)`, so the door is 200 cm under a
     210 cm ceiling. This is the same rule WP1 uses for seam doorways.
- **Rationale:**
  1. The spec gives no measure for "walkable fraction". Cell count alone cannot work: in the thin-walled LOBBY and
     wide MAZE almost every cell is walkable (~98 %), and in the narrow MAZE ~50 % is. The measure above counts
     thin walls and SOLID wall mass on one scale. Generated with exactly the §5.WP2 division, opening and erosion
     parameters, the LOBBY family measures 0.82–0.89 (mean ~0.86): about 13 % of its adjacencies are walled. Getting
     under 0.85 would need about 45 % more wall than the spec's own parameters produce. Seeds 1–200 in the test
     reach at most 0.894.
  2. The §5.WP2 narrow-maze algorithm by itself (parity lattice, growing tree, braid 0.3) is ~51 % walkable, which
     is below the 55 % MAZE band. The chambers also break up the 1.2 m corridors with small rooms.
  3. Each DOORWAY edge is one framed door (jambs and casing per edge, `src/mesh/trims.ts`). A 2- or 3-edge DOORWAY
     run would render as separate doors side by side.
- **Consumers affected:** none (WP2 only). The integrator's full-suite acceptance uses the WP2 test.
