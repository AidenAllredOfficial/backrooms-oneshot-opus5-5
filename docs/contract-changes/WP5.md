# Contract change proposals — WP5

(none yet — see TEMPLATE.md)

## 2026-09-24 — Per-cell palette wall/trim material for the mesher
- **WP:** WP5
- **Change:** add to `ChunkLayout` (core/layout.ts), written by WP1 from the district `ZonePalette` (and by stamps that change palette):
  ```ts
  wallMat: Uint8Array; // CHUNK_CELL_COUNT, palette wallMat of the cell (MatId)
  trimMat: Uint8Array; // CHUNK_CELL_COUNT, palette trimMat of the cell (MatId)
  ```
  plus the matching lines in `createEmptyLayout`, `cloneLayout` and `layoutTransferables`.
- **Rationale:** §5 WP5 rule 1b ("the palette wall material of that cell, `matNeg/matPos` if set") and rule 8 ("or the palette's trimMat") need the palette per cell, but the layout carries no wall/trim material, and `ZonePalette` is only reachable through `ZoneGenerator.palette(s, district)` in `src/world` (district-dependent, not importable data). `matNeg/matPos` cannot express "not set" because 0 is a valid MatId (WALLPAPER_L0), and OPEN edges next to SOLID cells normally carry no material.
- **Alternative (no core change):** WP1/WP2/WP3 guarantee `matNeg/matPos` = palette wallMat on every edge adjacent to a SOLID cell (including OPEN edges), and trims always use TRIM_PAINT. Needs to be written into the WP1 spec.
- **Consumers affected:** WP1 (writes), WP5 (reads), WP14 tools/map (optional).

## 2026-09-25 — Note (no contract change): TileState.VENT is meshed as geometry, not as a VENT_GRILLE decal
- **WP:** WP5
- **Change:** none requested. §5 WP5 rule 5 says "VENT: a quad plus a VENT_GRILLE decal", but `DecalKind`
  (core/ids.ts) has no VENT_GRILLE slot (VENT_GRILLE exists only as a `PropKind`, the wall-mounted grille of WP6),
  and the decal atlas is full (16 slots). WP5 therefore meshes a VENT tile as a square stepped-cone supply diffuser
  (src/mesh/ceilings.ts `emitDiffuser`): an outer METAL_PAINTED frame flush with the tile plane that owns the
  ceiling-chart texels like a tile would, three louvre rings stepping 12 mm up with dark slot risers, and a PLENUM
  throat, all with lightmap uv from the ceiling chart. This reads as a real diffuser with depth under grazing light,
  which a flat decal cannot.
- **Rationale:** recorded so the integrator and WP8 (decal atlas) do not look for a VENT_GRILLE decal slot. If a
  decal is preferred later, add `DecalKind.VENT_GRILLE` (needs a free atlas slot) and WP5 switches to quad + decal.
- **Consumers affected:** none.
