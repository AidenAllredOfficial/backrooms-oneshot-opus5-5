# R2 B4: exploration pacing, more landmarks, hero rooms, new kinds, Poolrooms variety

## Problem

Landmarks were about 10x rarer than the design called for: about 7 per km² per storey (0.69 per 8x8-chunk region). A
curious wanderer came within 12 m of one 0.25-0.28 times per km (design: 3.3 per km). The longest stretches with
nothing notable were 350-830 m on storey 0. Storeys had 6, 6 and 4 landmark kinds. Poolrooms was one model everywhere:
69% of its storey, 4 landmark kinds, and dull stretches of 565-715 m.

## Decisions

### Site density (world/sites.ts)
- Landmark regions are 3x3 chunks (was 8x8). `LANDMARK_P` is 0.9 (was 0.8). Regular landmarks must be at least
  2 chunks apart (Chebyshev; was 4). The brief proposed 4x4 regions. 3x3 was needed to clear the 1.5 per km
  wanderer bar with margin on storey 0 (4x4 measured 1.53 per km, 3x3 measures 2.1-2.6).
- Artery chunks: a region draw that lands on an artery becomes an ENDLESS_HALL only with p 0.4 (a storey-free hash).
  Otherwise the region retries another chunk. Storey 2 has no ENDLESS_HALL, so it always retries there instead of
  dropping the region. Without this, small regions would turn most arteries into endless halls.
- Positions stay storey-independent. Towers, elevators and arteries are unchanged: their hashes and retry order are
  untouched.

### Hero-room tier (world/heroRooms, sites.ts `heroOfSite`)
- Every district gets one hero room. The kind is a weighted pick among the `LandmarkGenerator`s whose `hero` zone list
  holds the district's zone and whose `storeys` hold the storey. The room is stamped in the district's own chunk
  nearest its site that has no regular landmark, tower, elevator or artery (3x3 search). The pick uses
  `rngFor(seed, SALT.LANDMARK, 0x4e20 + s, sx, sz)`.
- Hero rooms are landmark kinds. `landmarkAt` returns them after the regular landmark of the chunk. As a result,
  `goto=landmark:NAME`, `findNearest`, the map tool, the baker's `LANDMARK_LIGHT_R` and `l.landmarks` all handle them
  without special cases. `heroOnly` kinds never enter the regular lottery.
- `createSites(seed, forceLandmark, districts = null)`: without districts (old tests) there are no hero rooms.
- Zone lists:

  | Zone | Hero rooms |
  |---|---|
  | LOBBY | TALL_ROOM, CHAIR_STACKS, CRT_WALL, STAIRCASE_TO_CEILING, CONVERSATION_PIT |
  | MANILA | TALL_ROOM, CHAIR_STACKS, STAIRCASE_TO_CEILING, COPY_ROOM; storey 2 adds SHOWER_BLOCK |
  | DARK, MAZE | CHAIR_STACKS, CRT_WALL, STAIRCASE_TO_CEILING |
  | OFFICE | EXECUTIVE_SUITE, COPY_ROOM, CONVERSATION_PIT, CRT_WALL, CHAIR_STACKS |
  | LOW_EXPANSE | CONVERSATION_PIT, CRT_WALL; storey 2: LAZY_RIVER, SHOWER_BLOCK |
  | PILLAR_HALL | TALL_ROOM, CONVERSATION_PIT; storey 2: SLIDE_TOWER, LAZY_RIVER |
  | PARKING | HALF_LEVEL, TOLL_BOOTH, CRANE_BAY |
  | WAREHOUSE | MEZZANINE_OFFICE, CRANE_BAY |
  | PIPEWORKS, CONCRETE | VALVE_GALLERY, SUMP_PIT; CONCRETE on storey 2 adds SHOWER_BLOCK |
  | POOLROOMS | DRAINED_POOL, SLIDE_TOWER, LAZY_RIVER |

### New kinds (core/ids.ts, append-only; LANDMARK_COUNT 13 -> 38)
- Lottery kinds 13-24:

  | Kind | Storeys |
  |---|---|
  | STAIRS_TO_NOWHERE | 0, 1 |
  | LIGHT_WELL | 0, 1 |
  | SPLIT_LEVEL_HALL | 0, 1 |
  | RESTROOM_BLOCK | 0, 1 |
  | CAFETERIA | 0, 1 |
  | MOTEL_CORRIDOR | 0, 1 |
  | CHAPEL | 0 |
  | CHILDRENS_PLAYROOM | 0 |
  | DRAINED_POOL | 2 |
  | SLIDE_TOWER | 2 |
  | LAZY_RIVER | 2 |
  | SHOWER_BLOCK | 2 |

- Hero-only kinds 25-37: TALL_ROOM, CHAIR_STACKS, CRT_WALL, STAIRCASE_TO_CEILING, CONVERSATION_PIT, EXECUTIVE_SUITE,
  COPY_ROOM, HALF_LEVEL, TOLL_BOOTH, MEZZANINE_OFFICE, CRANE_BAY, VALVE_GALLERY, SUMP_PIT.
- Cross-storey restyles:
  - VENDING_ALCOVE and LOCKED_EXIT: all storeys (block on 1, tile on 2).
  - RED_ROOM: storeys 0 and 1.
  - SERVER_ROOM: storey 0 as an IT closet (one rack row, a workbench of CRTs, a wall patch panel, troffers).
- Lottery kinds per storey: 15 / 15 / 10 (was 6 / 6 / 4).
- `LANDMARK_LIGHT_R` (core/zones.ts) additions: LIGHT_WELL 18, SLIDE_TOWER 18, CRANE_BAY 14, TALL_ROOM 12, CHAPEL 12,
  MEZZANINE_OFFICE 12, LAZY_RIVER 12, DRAINED_POOL 12.

### Landmark details (QA views)
- SERVER_ROOM racks:
  - Every cabinet has a readable front, one of two types:
    - a perforated steel door (grate panel, handle, top vent strip, status LEDs);
    - an open front of 1U-4U equipment units with drive-bay slots and LED rows.
  - Every cabinet also has a perforated rear door with a handle.
  - A cable tray with cable bundles runs over each row.
- LOADING_DOCK:
  - The lip parapet is replaced by a see-through post-and-rail guard rail. Leveler plates, rubber bumpers and yellow
    bollards mark two berths.
  - Two large closed roll-up doors stand in the well's back wall, with daylight leaking under them and a red or green
    signal lamp each.
  - The entrance roll-ups hang half lowered above head height.

### Poolrooms (zones/poolrooms.ts, core/zones.ts)
- `STRATA_WEIGHTS[2]` is `[0, 4, 0, 0, 10, 14, 0, 60, 0, 4, 0, 8]`. This adds a PIPEWORKS / CONCRETE service stratum.
- `districtParams.variant` is drawn last, so the WP3 params keep their values. Variants:
  - CLASSIC 40%.
  - TUNNELS 15%:
    - Solid tile rooms cut by 2-cell tube corridors, with one 210 cm arch per lattice wall.
    - Ceilings are 250 cm. Water stands +30 cm deep; solid cells now hold flood water in the curb rule.
    - A [4, 4] panel lattice.
  - TERRACES 15%:
    - Every group has a 60 or 90 cm terrace with a 4-6 step ramp.
    - Arch ramps get about 15 cm risers.
    - Each terrace has 1-2 waterfalls: a glowing sheet of water on the riser, wet floor, and a WATER emitter.
  - SUNLIT 15%: vaulted halls under a [4, 4] lattice of 6500-7000 K, 5200-nit daylight panels.
  - DRAINED 15%:
    - Dry basins 150-210 cm deep with 3-cell stepped entries, stains, fallen tiles and a drip.
    - Their underwater lights still burn.
    - No flooded rooms and dry channels.
- New lottery kinds: SLIDE_TOWER, LAZY_RIVER, SHOWER_BLOCK and DRAINED_POOL. SLIDE_TOWER has an 11 m hall, a 40-riser
  stair, a 6 m platform and a helical tube slide.

### Pipe solids
`props/pipes.ts` draws every pipe solid as plumbing: paint or rust by decay, flanges, and ceiling hangers on level
runs. Landmark railings therefore use thin boxes for level rails and posts. Only sloped runs (stairs, goose-necks) use
pipe solids, because runs steeper than about 17 degrees never get hangers. The slide's bore is 0.422 m, which selects
the blue-grey paint. pipes.ts draws a pipe rusty when the decay byte of its midpoint cell is >= 150, so the slide
stamp caps the decay of those cells at 120 (verifier fix: at seed 7 the tube rendered as a rusted sewer main).

## Measurements (8 seeds, 48x48 chunks per storey)
- Regular landmarks: 57 / 57 / 94 per km² on storeys 0 / 1 / 2. With hero rooms: about 99 per km².
- Every one of the 38 kinds appears.
- Chunk generation (tools/map.ts --bench 300): mean 3.4-3.5 ms, p95 6.6-7.5 ms.
- Wanderer (tests/world/pacing.test.ts, 3 seeds x 2 runs x 2.4 km per storey):

  | Storey | Landmarks + hero rooms per km | Median gap between them | 90th-percentile gap incl. vignettes |
  |---|---|---|---|
  | 0 | 2.57 | 304 m | 238 m |
  | 1 | 2.01 | 328 m | 209 m |
  | 2 | 2.78 | 253 m | 287 m |

## Tests owned by other batches that need updates after the merge
- `tests/world/structures.test.ts` "footprints and storeys follow the spec table": new storeys are RED_ROOM [0, 1],
  LOCKED_EXIT [0, 1, 2], VENDING_ALCOVE [0, 1, 2] and SERVER_ROOM [0, 1]. The registry test also needs the count
  (38) in its title.
- `tests/world/seams.test.ts` "landmarks ... >= 4 chunks apart": the minimum is now 2 chunks, and only between
  regular landmarks (a hero room may sit next to one).
- `tests/world/zones-deep.test.ts` POOLROOMS:
  - Walkable fraction: TUNNELS districts are about 44% walkable. They need the PIPEWORKS threshold (0.45 -> 0.4), or
    tunnels must be excluded from the 0.7 minimum.
  - Palette / lighting spec: TUNNELS and SUNLIT use a [4, 4] lattice at 1800 / 5200 nits; SUNLIT uses 6500-7000 K;
    TUNNELS ceilings are 250 cm.
  - "every pool is reachable via its stepped entry; deep water NOWALK": DRAINED pools have no water.
