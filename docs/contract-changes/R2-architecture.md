# R2 — Level 0 architecture (batch B5)

Vertical variety, missing ceilings, doors and windows, room programs, district character and zone transitions.
No core contract changed: everything uses existing ids (EdgeKind HALF / RAIL / WINDOW / DOORWAY / PARTITION,
EdgeTrim THRESHOLD / EXIT_SIGN / CASING, CellFlag NO_CEIL / NOWALK / WET, CeilKind OPEN_DARK, TileState MISSING /
STAINED / SAGGING / NEW / VENT, PropKind DOOR_LEAF / CONE / BUCKET / MOP / ..., FixtureKind PENDANT_LINEAR / SODIUM /
CAGE_BULB / UNDERWATER / EXIT_SIGN / TUBE_STRIP). All new structures are stamped from INSIDE zone generators
(`generate()`), never from chunkgen (B4-owned). Golden hashes change (tests/world/golden.json is B4's; not edited).

## Shared stamp modules (src/world/structures)

| module | what | used by |
|---|---|---|
| `util.ts` | reach-from-ports count, layout snapshot / restore (try-then-revert), cell / edge helpers | all below |
| `splitLevel.ts` | split-level hall (sunken 3.0 / 4.5 m under the district ceiling), light well, stair + balustrade | LOBBY family, OFFICE, CONCRETE |
| `plenum.ts` | open ceiling patch (NO_CEIL + OPEN_DARK + deck / joists / duct / pipes / cables solids), scattered tile states, "fixtures pulled" bays | LOBBY family, OFFICE |
| `doors.ts` | DOOR_LEAF placement on DOORWAY edges (open / ajar / closed, dead-end rule), `placeLeaf` | MANILA, OFFICE, CONCRETE, closets, connectors, towers |
| `windows.ts` | windows to nowhere: a WALL run thickened into an outer wall (SOLID strip), WINDOW edges with glowing frosted panels | LOBBY family, OFFICE |
| `programs.ts` | room programs + district characters | LOBBY family (OFFICE: restroom / kitchenette) |
| `transitions.ts` | zone-transition connectors (hard boundaries) and palette dither (soft boundaries) | LOBBY family, OFFICE, CONCRETE, PILLAR_HALL, LOW_EXPANSE (dither), PIPEWORKS |

Every stamp that can cut the walkable graph (split halls, wells, programs, window strips, connectors) is applied to
the layout, then `unreachedWalkable()` (walkable cells not reached from the seam ports, WP1 rule incl. ramps) is
compared with its value before; a stamp that raises it is reverted from a snapshot. The LOBBY division model is
re-synced from the grid afterwards (`syncModel`), so later `joined()` checks see the new edges.

Onboarding rule: on storey 0 the 3x3 chunks around the origin (the spawn search area) get none of the new
LOBBY features (split halls, tall rooms, stages, wells, open ceilings, programs, character dressing, windows,
connectors), and the district whose site lies within 5 chunks of the storey-0 origin is always character NORMAL,
so the spawn keeps the Level 0 photo composition. All R2 draws come from forked rngs (`ctx.rng.fork(tag)`), so the
base LOBBY division of a chunk is unchanged wherever no feature lands.

## 1. Vertical variety

- **Split-level hall** (`buildSplitHall`): hall 7-10 x 11-14 cells (LOBBY), the whole 14 x 14 block (OFFICE
  ATRIUM), or the inset of an 10-12 x 12-14 utility room (CONCRETE). Hall floor = base − 300 (70 %) / − 450;
  ceiling unchanged, so the hall is 5.7-7.2 m (LOBBY / OFFICE) or 6.3-8.1 m (CONCRETE) tall. Perimeter: HALF
  parapet, hA = base + 95, with a METAL_PAINTED pipe handrail on top; the stair head is OPEN. Stair: a 2-3-cell
  ramp solid (15 visual steps; 5 cells for 3.0 m, 7 cells for 4.5 m) hugging one long side; its open side is a
  stepped RAIL stringer curb (15 cm above each cell's low end: non-walkable for the graph, not an occluder) with a
  sloped pipe handrail on posts. Optional full-height SOLID columns (CONCRETE_WALL, WALL-wrapped) in two rows.
  "Lit from below": PENDANT_LINEAR (1.2 x 0.2 m, 7000-9000 nits) hung 3 m above the hall floor on a ~3 x 4 cell
  grid (cables up to the ceiling), in addition to the lattice troffers overhead. LOBBY: in the ring around the hall
  (1 cell, the gallery) all interior edges and thick blocks are cleared, so every room that touched the region
  stays connected through the gallery. Rates: districts with `hash(district.id) < 0.2` get one in 65 % of their
  chunks, other LOBBY-family districts in 8 %; OFFICE ATRIUM = 10 % of blocks (taken from the CUBICLES share; a
  sunken open-plan office of desks / chairs / CRTs on the hall floor); CONCRETE: districts with hash < 0.3, 50 % of
  chunks (pallets and crates on the hall floor).
- **Tall rooms** (LOBBY, 5 % of leaves >= 16 cells, min side 4): ceilCm 450 / 480 / 540 / 600; the district lattice
  slots inside the room (clear of walls by half a cell) get PENDANT_LINEAR troffers at floor + 3.0 m (9000 nits);
  their 1 x 2-tile footprint occupies the slot, so WP4's lattice placer leaves it to them.
- **Sunken rooms** p 0.06 → 0.18 (leaves >= 16 cells, min side 4 → a 2 x 2 "conversation pit" at minimum),
  depth 45 cm (3 steps, 1-cell ramp) or 90 cm (30 %, 6 steps, 2-cell ramp). **Stages** (+45 cm, p 0.1 of the
  leaves that are not sunken): the inset floor is raised, the ramp cells keep the base floor and climb inward.
- **Light well** (8 % of LOBBY-family chunks): 2 x 2 / 3 x 3 cells, floor base − 600, NOWALK; RAIL rim (90 cm
  CONCRETE_WALL curb-parapet + pipe handrail); shaft walls concrete (or POOL_TILE with water). Bottom: still water
  (WaterRect kind 1, 45 cm) with an UNDERWATER lamp (turquoise, 5200 nits), or a lit floor under a CAGE_BULB.
- **Pits** (structures/pit.ts): p 0.08 where the district-mean decay > 0.5 (was 0.7), p 0.03 anywhere else (any
  mood). Ringed by traffic cones and sometimes a wet-floor sign; a faint 2700 K CAGE_BULB (22 cd) on the shaft
  wall 5 m down (explicit id hash3(pickSeed, SALT.ANOMALY, 0x9175)) makes the hole read as depth.
- **Stair towers** (structures/tower.ts): a caged emergency bulb (storey fixture, bakeGroup 0, id
  `structureFixtureId(towerId, SALT.TOWER, 64)`, 95 cd, 2900 K) 16 cm off the wall over the exit, and the exit's
  metal DOOR_LEAF propped open ~172 deg flat against the tower's outer wall; the vestibule bulb 48 → 85 cd so light
  spills out. (B6 adds the 'STAIRS ->' wall signs.) LOBBY bulkhead rings skip cells next to a tower.

Measured (tools-style stats over 14 x 14 storey-0 chunks, 3 seeds): 2.4-3.4 % of walkable storey-0 cells are off
floor 0 (was 0.45 %).

## 2. Missing ceilings

`ceilingDecay` (LOBBY family, storey style 0) per division leaf, decay sampled at the leaf centre:
- decay > 0.6: with p 0.02 + 0.2 (decay − 0.6) (2-8 % of the rooms) an **open ceiling** patch of 2-4 x 2-5 cells:
  NO_CEIL + CeilKind.OPEN_DARK + ceilMat PLENUM, ceilCm raised by 80-110 cm to the structural deck (walls run up
  to it), furnished with a METAL_DECK slab, METAL_RUST bar joists every 1.2 m, a METAL_PAINTED duct, 1-2 pipes and
  1-3 dangling cables, fallen tiles / debris underneath; the tiles around the hole go MISSING with p 0.3;
- decay > 0.45: p 0.25 scattered MISSING tiles over a sub-rect (WP5 renders each as a plenum box);
- otherwise p 0.05 a "fixtures pulled" gloom bay: the lattice slots of the leaf lose one tile per candidate rect
  (MISSING), so the lattice placer leaves the bay dark.
OFFICE: `blockDecay` per 14 x 14 block (decay > 0.6: open patch with p 0.08 + 0.4 (decay − 0.6); decay > 0.45:
scattered missing tiles).

## 3. Doors, windows, programs, districts

- **Door leaves** (`hangDoors`): per interior DOORWAY edge, hashed (seed, SALT.PROP, tag, edge): MANILA p 0.35,
  OFFICE p 0.42, CONCRETE p 0.35 (realised shares ~35-39 % of doorways; the rest fail the swing-space test).
  70 % open 85-100 deg (swing side with free floor; prefers the hinge whose leaf rests along a wall), 20 % ajar
  15-40 deg, 10 % closed — ajar / closed only where one side is a dead end (a pocket of <= 24 cells without ports
  reached only through this door), swung into / closing that pocket; otherwise they become open. Collision stays on.
  Variants: MANILA wood, OFFICE painted (25 % wood), CONCRETE / fire doors metal.
  Verify pass: an open leaf juts ~0.9 m into its swing cell, so it may only swing where it rests against a
  perpendicular wall at the hinge jamb or the space continues past its free edge (`leafClear`: the swing cell's far
  edge is passable into walkable floor). Before, leaves swung into 1-cell corridors running along the door line and
  walled them off for the player while the graph still called them connected (seen at a MANILA connector, seed 1).
  Connector fire doors use the same rule: into the host if clear, else back into the connector against its side wall,
  else no leaf.
- **Windows to nowhere** (`windowWall`): p 0.45 in chunks touching a district BOUNDARY seam (the run nearest to the
  boundary is preferred), 0.08 elsewhere; LOBBY family and OFFICE. A straight WALL run of >= 4 edges becomes an outer
  wall: the strip of cells behind it turns SOLID (WALL-wrapped), then pier / window / window / pier ...: WINDOW edges
  (sill 95, head 200) each backed by a frosted panel — a RECT fixture of FixtureKind.SODIUM geometry (flat
  emissive lens + a housing hidden in the solid strip) at 6300-6800 K, 800-1500 nits, 4 cm inside the reveal; half
  of the runs have venetian slats (PLASTIC boxes 3 cm tall on a 5 cm pitch: dark bands with bright slits; the first
  cut used 4 mm slats on a 7 cm pitch, which read as drawn hairlines, not a blind) over the upper 25-70 %. OFFICE never puts the strip on an
  aisle cell. Note for B2: assignFixtureStates may switch these panels OFF / DYING like any light (a dead window
  reads as grey frosted glass); an exemption for vertical SODIUM panels would keep them glowing.
- **Room programs** (13 % of LOBBY-family leaves, by size; `applyProgram` tries and reverts):
  CLOSET (<= 6 cells: one DOORWAY kept, the other openings walled, a leaf ajar / closed / open, floor-to-ceiling
  wire shelving from box solids, boxes, bucket + mop, a bare 2600-2900 K caged bulb; the lattice slots become VENT
  tiles), RESTROOM (12-30: POOL_TILE wall faces, POOL_MOSAIC floor, 2-4 PARTITION stalls (metal, hA 150) along the
  longest wall, a 2-cell TERRAZZO vanity of blocker cells opposite, bin / wet-floor sign; only on enclosed rooms: no
  WINDOW edge on the boundary (OFFICE rooms have corridor glazing) and at most 3 open boundary edges), COPY_ROOM (8-16: a copier
  of box solids, filing cabinets, boxes, paper on the floor), CONFERENCE (16-40, min side 4: office carpet, a
  conference table and chairs), KITCHENETTE (9-24: VCT, a WOOD counter of blocker cells, a vending machine with its
  VENDING panel, water cooler, bin). OFFICE ROOMS blocks: 18 % of rooms become restrooms or kitchenettes.
- **District characters** (`districtParams.character`, weights NORMAL 0.55 / WATER_DAMAGED 0.15 / RENOVATION 0.12
  / MOVED_OUT 0.10 / PRISTINE 0.08; appended after the other params, so existing params keep their values):
  WATER_DAMAGED: noise blobs of 2 cm water film (WET + WaterRect kind 2), stained (10-30 %) / sagging (2-8 %)
  tiles, a few missing, DRIP emitters; RENOVATION: a third of the division walls bare DRYWALL, 1-2 walls stripped to
  their stud frame (RAIL 5 cm bottom plate + WOOD stud / top-plate box solids — connectivity unchanged), plastic
  sheeting, paint buckets, NEW replacement tiles and holes; MOVED_OUT: CARPET_OFFICE floor (palette), dark outline
  stripes where desks stood, floor cable bundles (RUBBER pipes), leftover boxes; PRISTINE: brighter and cooler
  troffers (3800 nits, 4000-4800 K), NEW tiles.

## 4. Zone transitions (`transitionStamps`)

Hard BOUNDARY seams: behind each narrow opening (DOORWAY or HEADER <= 220 cm, 1-3 cells, clear of the line ends) the
host side builds a connector 2-3 cells deep: side walls, bulkhead ceiling at floor + 230, the neighbour's floor /
wall material up to the midline and the host's beyond, and at the inner end fire doors (DOORWAY hA 210 with CASING |
THRESHOLD | EXIT_SIGN trim; the middle cell of three is a wall), metal leaves propped open into the host (88-98
deg), an EXIT_SIGN fixture (150 nits) over the door on the connector side. Host = the lower ZONE_RANK (PIPEWORKS 0,
CONCRETE 1, PILLAR_HALL 3, DARK 4, MANILA 5, LOBBY 6, OFFICE 7, LOW_EXPANSE 8 (its 210-230 cm ceiling cannot take
the bulkhead)); zones without a hosting generator (MAZE, POOLROOMS, PARKING, WAREHOUSE) rank Infinity, so the other
side hosts; ties go to the lower district id. Deep hosts and storey 1 build a CMU service corridor with a TUBE_STRIP;
on storey 1 its floor is 20 cm down, ramped back up at the inner end (no leaf there).
Soft BOUNDARY seams: both sides dither the neighbour's floor material into their first three cell rows (p 0.55 /
0.3 / 0.12 per hashed global cell) and give alternate wall pieces of the first two rows the neighbour's wall
material. Seam lines themselves are untouched (seams.ts stays the pure shared contract).

## 5. Lighting

- LOBBY_LATTICES + [6,6], [4,8]; district lattice drawn with weights 0.3 / 0.25 / 0.25 / 0.1 / 0.1 (the photo
  lattices stay 80 %). Fixture-free bays: see "fixtures pulled" above.
- MANILA troffers 3300-3800 K → 4800-5300 K (sickly cool office).
- `addCustomFixture` luminance jitter: lognormal `exp(0.18 * gauss)` (clamped to ±3 sigma), matching B2's lattice
  placer. (deepcommon's placer keeps its ±6 %: WP3 tests pin minimum bulb intensities.)
- `addCustomFixtureUnique` skips a custom fixture whose (kind, lattice tile) is already taken (id collision).

## Performance

Chunk generation (Node, 196 storey-0 chunks, 3 seeds): mean 2.6-3.3 ms, p95 5.4-6.4 ms (was ~2.5 / 4.6).
