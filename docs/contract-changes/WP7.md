# Contract change proposals — WP7

Append one entry per proposed change. Changes must be additive. The orchestrator merges them into
`src/core/*` and records the decision in STATUS.md.

None of the entries below changes a `src/core` type or signature. The ones marked "Decision needed" record where
the WP7 implementation deviates from, or has to interpret, the §5 WP7 text. Please confirm them or rule on them.

## 2026-09-24 — K_MAX tail is approximated, not dropped (spec note)
- **WP:** WP7
- **Change:** none to core. §5 WP7 "K_MAX ... the rest are dropped (their sum is < 2% in practice; asserted in the
  bench)". The bench measures otherwise. The estimate share of the lights ranked after the K_MAX = 16 strongest is
  12.9% on average in LOW_EXPANSE (R 14, dense lattice), up to 41%, and about 30% under the ATRIUM's 12 m lattice.
  Dropping those lights makes open zones visibly darker than the tall-light acceptance allows. The baker therefore
  keeps them as a **tail**. Their irradiance is `I_max·w(d)/d²·max(0,n·ω)·max(0,−nL·ω)`, gated by the owner cell's
  visibility bitset (full bake, patch cache and light volume) or by its light region (preview). No rays are cast.
  The bench prints the tail share instead of asserting < 2%.
- **Rationale:** acceptance "Tall lights ≥ 85% of the unwindowed sum", and realism in LOW_EXPANSE, PILLAR_HALL and
  POOLROOMS.
- **Consumers affected:** none (internal to WP7). Spec text §5 WP7 "K_MAX" and bench bullet.

## 2026-09-24 — Window distance for tall lights (spec interpretation)
- **WP:** WP7
- **Change:** none to core. The window `(1 − (d/R)⁴)²` uses `d² = horizontal² + max(0, |Δy| − hAllow)²`, where
  `hAllow` is the light's mount height above its own floor. Tower lights use `hAllow = 0` (plain 3D distance, so
  their replica set stays finite).
- **Rationale:** with the plain 3D distance, an ATRIUM panel at 12 m with R = 20 already weighs 0.76 directly
  below, and the "≥ 85% of the unwindowed sum" acceptance cannot pass.
- **Consumers affected:** none.

## 2026-09-24 — Preview budget (Decision needed)
- **WP:** WP7
- **Change:** raise the §5 WP7 / §8 preview target from **≤ 60 ms** to **≤ 250 ms** at `high` (tpc 12). The
  alternative is to state that the target applies at tpc 8.
- **Rationale:** measured on the target machine (Ryzen 9 8940HX, while other agents were running). A preview does
  the same fixed per-texel work as the full bake on 150–210 k valid texels plus gutters: texel setup (15–25 ms),
  dilation and encoding (20–35 ms), and the light volume (10–15 ms). That is already about 60 ms before any
  lighting, so ≤ 60 ms cannot be met at tpc 12 however cheap the lighting is. Current preview p95, where each
  chunk's first tile is cold (it fills the chunk's bitset cache, which the full bake then reuses): WAREHOUSE 86,
  LOW_EXPANSE 174, PILLAR_HALL 173, POOLROOMS 176, ATRIUM 238, LOBBY 303 ms. Warm tiles take 130–170 ms.
- **Consumers affected:** WP10 (streaming priorities, if they assume 60 ms), §8.3 budget table.

## 2026-09-24 — Light-volume `a.rgb` meaning (Decision needed; the doc comment in core/mesh.ts is unaffected)
- **WP:** WP7
- **Change:** `volume.a.rgb` holds the irradiance on a surface facing the dominant direction: the sum of the
  direct deltas plus the direction-averaged indirect L0. It is **not** the hemisphere average of the direct light.
  `b.w = |V| / luma(a.rgb)`.
- **Rationale:** WP9 decodes the volume exactly like the lightmap
  (`dl.color = w·Ē/max(dot(brNg,d),0.2)`, `irradiance += (1 − w)·Ē`). A prop face that points at a single lamp
  then receives Ē. With a hemisphere-average L0 it would receive Ē/4 and props would be 4× too dark next to walls
  and floors.
- **Consumers affected:** WP9 (no code change: this matches its decode).

## 2026-09-24 — Directionality denominator (spec interpretation)
- **WP:** WP7
- **Change:** `dir.a = |Σ E_l ω̂_l| / E`, where E is the TOTAL static irradiance (direct + indirect × AO) in
  luminance. The numerator sums direct light only.
- **Rationale:** in the shader, `w·E` is the directional part and `(1 − w)·E` the ambient part. Dividing by the
  direct sum only would push the indirect light into the directional lobe.
- **Consumers affected:** none (WP9's decode is already written this way).

## 2026-09-24 — wallMask height (spec interpretation)
- **WP:** WP7
- **Change:** `wallMask` bits are set where the edge occludes 1.2 m above the HIGHER floor of the two cells. This
  is the same rule as `nb.region()`. The bits are also set toward SOLID cells and toward cells of another tower
  group.
- **Rationale:** on raised floors, an absolute y = 1.2 m can lie below the floor.
- **Consumers affected:** WP9 (props LV clamp). No change is needed there.

## 2026-09-24 — Texel indirect from an ambient cube (algorithm refinement, informational)
- **WP:** WP7
- **Change:** none to core. Each probe still projects its rays to SH-L1 RGB, and the light volume uses that. It
  also stores six cosine-weighted axis irradiances (an ambient cube), and lightmap texels evaluate indirect light
  from the cube, `E(n) = Σ n_a² E(sign n_a)`.
- **Rationale:** SH-L1 rings on strongly directional fields. A floor under a bright spot got negative (clamped to
  0) upward irradiance with a blue shift, visible in `testScene=cornell&view=lightmap&bakeTerm=indirect`. The cube
  is exact for the axis-aligned shell surfaces.
- **Consumers affected:** none.

## 2026-09-25 — Audit note: bench numbers (Decision needed, supersedes the preview figure above)
- **WP:** WP7 (audit)
- **Change:** none to core. Measured with low machine load after the audit's direct-pass change: weak lights
  (< 5% of a receiver's estimate) now classify their 4x4 sub-blocks with one centre ray per corner texel instead of
  4 shadow samples, and shadow fractions are memoized per patch. The error against per-texel shadow rays does not
  change (ATRIUM/OFFICE tile: mean 0.66% against 0.63% before). Rays drop by 28% on OFFICE tiles, and the gain in a
  same-tile A/B timing is about 10%.
  - Full warm p95: LOBBY about 380 ms. Tiles whose neighbourhood is OFFICE content (desks, cubicle partitions,
    around 3M rays) take about 700 to 800 ms and still fail the 600 ms gate; the ATRIUM bench zone is surrounded by
    OFFICE chunks.
  - Preview: 95 to 150 ms in LOBBY and 300 to 340 ms on OFFICE tiles, where furniture needs one DDA ray per 2x2
    block and light. The earlier ≤ 250 ms proposal therefore does not cover OFFICE content either.
- **Options:** (a) accept full ≤ 900 ms for OFFICE-content tiles and preview ≤ 350 ms; or (b) make the preview spec
  literal (bitset classes only, no furniture rays) and accept that the preview shows no desk shadows.
- **Consumers affected:** WP10 (streaming priorities), §8.3 budget table.

## 2026-09-25 — Speed pass and bench status (Decision needed; supersedes the audit note above)
- **WP:** WP7
- **Change:** none to core. Changes inside `src/bake` and `tools/bakebench.ts`. Each one leaves the bake output
  byte-identical (checked on 8 tiles in 6 zones, full and preview):
  - `beam.ts` (new): a ray-free FULL proof for the (patch, light) classification. The segments the direct pass can
    cast for a patch all lie in the box swept from the patch's texel box to the emitter box. When that swept box
    meets no closed cell, occluder box, closed edge or corner post, the pair is FULL with no rays. All tests are
    conservative. `tests/bake/beam.test.ts` checks the proof against the DDA and checks that the output does not
    change. On OFFICE tiles, classification rays drop from 1.04M to 0.53M.
  - DDA: each cell stores the height range of its boxes, so a segment that passes above or below all of them skips
    the box list. Before this, about 85% of the box checks never overlapped in height. The per-cell DDA data is now
    interleaved.
  - AO: each cell has a precomputed, de-duplicated list of the boxes in its 3x3 neighbourhood, plus an early reject
    by xz distance. Probe interpolation accumulates only the ambient cube for texels and only the SH for the light
    volume. Lattice neighbours are computed once per texel.
  - Measured and rejected, because each one raised the error against a per-texel ground-truth bake:
    - weak lights using a patch-level visibility fraction (ATRIUM mean error 0.75% to 1.81%);
    - 6-texel sub-blocks (0.75% to 0.95%);
    - sub-blocks aligned to the patch (0.75% to 0.82%).
    Also measured and rejected, because they save almost nothing:
    - beam tests per sub-block (neutral);
    - a looser 2x2-interpolation tolerance in blocks with uniform visibility (7 ms);
    - inheriting visibility from lattice neighbours (26k rays).
- **Bench** (`node tools/bakebench.ts`, seed 1, high). The target machine is a Ryzen 9 8940HX laptop, measured while
  other agents kept the load average at 5 to 10.
  - Full warm p95 (gate 600 ms), all pass:

    | LOBBY | LOW_EXPANSE | PILLAR_HALL | POOLROOMS | WAREHOUSE | ATRIUM |
    |---|---|---|---|---|---|
    | 360 | 278 | 385 | 452 | 199 | 578 |

    The ATRIUM figure comes from the OFFICE chunks around the landmark. It ranged from 670 to 740 before this pass,
    and its worst tile takes 556 to 580 ms (best of 5) when the machine is quiet.
  - Cold max (gate 900 ms), all pass: 498, 346, 385, 441, 247 and 636 ms, in the same zone order.
  - Preview p95 (gate 60 ms), all fail: 259, 146, 186, 203, 93 and 259 ms. The fixed per-texel stages alone take
    more than 60 ms at tpc 12. On 150 to 185k texels these are texel setup (20 to 30 ms), dilation and encoding (30
    to 45 ms) and the light volume (15 to 25 ms). A preview's first tile in a chunk is also cold (it fills the chunk's
    bitset cache). Removing the preview's furniture rays saves 40 to 50 ms on OFFICE tiles and nothing in LOBBY.
  - Time-to-ready (gate 2.5 s), 12 workers, one process per zone, run under that load:

    | LOBBY | LOW_EXPANSE | PILLAR_HALL | POOLROOMS | WAREHOUSE | ATRIUM |
    |---|---|---|---|---|---|
    | 2.65 s | 2.06 s | 2.54 to 2.96 s | 2.68 s | 1.82 s | 2.65 to 2.80 s |

    Parallel scaling is poor on this laptop. PILLAR_HALL takes 10.5 s on 1 worker and 2.54 s on 12, a speed-up of
    4.1x: each bake thread runs about 2.4x slower when 12 of them run at once. The likely causes are the all-core
    clock, memory bandwidth and the other agents' load.
  - Time-to-ready now has two dispatch models (`--ttr-policy`):
    - `static` (default, the §5 WP7 "chunk affinity" model): contiguous runs of tiles, one run per worker.
    - `pool`: the game's WorkerPool. A job goes to its chunk's home worker if that worker is idle, else to any idle
      worker. With 36 jobs queued this sends most jobs to cold caches. On ATRIUM, `pool` took 3.1 to 3.3 s where
      `static` took 2.65 s under the same load.
- **Decisions needed:**
  1. Preview budget: accept a preview p95 of 150 ms, or 300 ms for OFFICE-content tiles, at tpc 12, or define the 60
     ms target at tpc 8.
  2. Time-to-ready: accept it as a measurement on a quiet machine, or raise it to 3 s. This machine cannot run 12
     bake threads at single-thread speed.
  3. WP10: when a whole neighbourhood of bake jobs is queued, soft affinity makes time-to-ready about 20% longer than
     strict chunk affinity. Strict affinity means holding a bake job for its home worker while that worker is busy,
     when more bake jobs are queued than there are workers.
- **Consumers affected:** WP10 (streaming priorities and pool policy), §8.3 budget table.
