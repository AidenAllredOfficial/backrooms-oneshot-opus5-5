# Rendering audit, September 2026

This audit covered the live frame loop, lighting and baked-data streaming, surface shaders, reflection captures, water, SSAO, screen-space reflections, post-processing, dynamic resolution, timer queries, and GPU resource lifecycles. The main concern was image correctness while walking, turning, and receiving streamed lighting updates.

The fixes address 25 groups of demonstrated defects or unnecessary work. They include new regression coverage and updates to the rendering contracts in [DESIGN.md](DESIGN.md) and [TEX2.md](contract-changes/TEX2.md). This is a source audit plus GPU validation on one development machine. It does not establish that every possible driver or scene defect is gone.

## Findings and fixes

| # | Priority | Finding | Change and evidence |
| --- | --- | --- | --- |
| 1 | High | The planar mirror rendered before the main depth pass updated the flashlight shadow map. Three could update the cookie/shadow matrix while sampling the previous frame's shadow depths. Fast turns therefore paired a current matrix with stale depths. | Render the mirror in the frame graph after the main depth prepass, at hook order 5. The moving-light regression verifies main depth, mirror depth, mirror shading, main shading, and exactly one shadow update per frame. |
| 2 | High | Ordinary gameplay passed the previous camera pose and world matrix to streaming and lighting. Only capture-gate frames prepared the camera early. | Apply the current player pose and update the camera matrix before both consumers. A two-frame regression checks the pose and matrix each sees. |
| 3 | High | Budgeted preview-to-full lightmap swaps changed displayed irradiance before direction, flicker, emission, volume, and wall-mask data. Frames and atlas uploads could mix different bakes. | Upload replacement textures into pooled staging slots and publish all nine bindings synchronously. Tests pause after each upload and cover restart, disposal, optional channels, different sizes, failures, and cancellation. |
| 4 | High | The opaque color pyramid sampled attachment 0 alone on MRT frames. Routed baked and environment specular in attachment 1 disappeared from SSR and water refraction inputs. | Build the pyramid from attachment 0 plus attachment 1 before filtering. This preserves complete opaque lighting while excluding the current SSR result, avoiding recursive feedback. Tests check both MRT and plain-frame bindings. |
| 5 | High | SSR multiplied reflected radiance by scalar Fresnel throughput. Colored metals became neutral as hit confidence increased. | Add an RGBA16F attachment carrying RGB throughput, including haze and cavity visibility. The composite reads it per pixel; decal coverage attenuates it. Numeric tests check hue through confidence transitions and small dielectric weights. |
| 6 | Medium | The SSR march fraction is linear after perspective division. Multiplying it by view-space ray length produced incorrect distance fades and miss-kernel sizes. | Recover metric distance as `L*t*w0 / mix(w1,w0,t)`. A 10 m receding hit from depth 8 m previously reported about 37.8 m. Perspective and endpoint regressions cover the conversion. |
| 7 | Medium | SSR block filtering combined separate surfaces with similar roughness, producing unstable normals at creases and foreground boundaries. | Gate samples by normal agreement and distance to the representative's macro depth plane. Sloped floors and corrugated surfaces retain filtering; other planes are rejected. |
| 8 | Medium | A steady cube-probe update refiltered rough mips only on the captured face. GGX samples cross face boundaries, leaving neighboring rough reflections stale. | Copy the changed sharp face and refilter every rough face. Tests verify all rough faces see each refresh. |
| 9 | Medium | Stream-triggered probe refreshes published filtered faces while the six-face capture was incomplete. | Retain the last complete filtered cube until the capture finishes, then publish the complete refresh. The scheduling regression checks the intermediate frames. |
| 10 | Medium | Planar water lookups outside the capture, or behind the mirrored eye, repeated clamped edge radiance. | Fade to the existing environment/probe fallback. Widen the border fade for rough, stretched footprints. Optical regressions cover the bounds and blur footprint. |
| 11 | Medium | Planar captures did not restore the caller's cube face, mip level, MRT flag, reflection flag, and wire-pixel uniform. Failures could affect subsequent passes. | Save and restore the full caller state in `finally`. Tests exercise nested targets and render failures. |
| 12 | Medium | Prepass visibility tests used potentially stale object transforms. Main, mirror, and late draws also repeated scene matrix traversals. | Update the scene before visibility checks and share frozen matrices across the depth/shading/hook/late draws. Restore automatic updates on every exit. |
| 13 | Medium | ScenePass could leave matrix updates, MRT mode, clearing, or water-volume mode changed when a hook threw. | Restore frame-global and renderer state in `finally`; a failing-hook regression verifies recovery. |
| 14 | Medium | Wet/glazed metal changed the direct specular F0 carrier but omitted Three r186's metallic environment carrier. Direct and environment lighting disagreed. | Apply the same F0 edit to the environment carrier while preserving diffuse contribution. Numeric tests execute the actual scalar shader edit blocks. |
| 15 | Medium | Detail cavity shading attenuated inline environment reflections but omitted routed fallback and SSR throughput. Reflection confidence changed cavity brightness. | Apply matching cavity visibility to the routed base environment and scalar/RGB weights. Preserve baked directional and separate clearcoat terms. |
| 16 | Medium | POM evaluated `sqrt(1-cosine*cosine)` without bounding a normalized cosine against floating-point overshoot. Face-on samples could become NaN. | Clamp the cosine to `[0.06,1]` first; numeric coverage checks the face-on limit. |
| 17 | Medium | Rust, paint-detail, and glare shaders used five descending-edge `smoothstep` calls. GLSL leaves their result undefined. | Express descending ramps as `1-smoothstep(low,high,x)`. Shader checks enforce ascending constant edges and test the intended ramp values. |
| 18 | Medium | Atlas trilinear footprints could include invalid cardinal or diagonal neighbors despite a valid center tile, sampling a reused slot's old irradiance. | Validate neighboring residency and clamp footprints away from missing tiles and window edges. Loaded seams retain interpolation. Regressions cover cardinal and diagonal gaps. |
| 19 | Medium | SSAO normal reconstruction chose a repeated, clamped depth sample at screen borders. The zero derivative could replace a sloped surface normal with a facing-camera normal. | Use an inward neighbor at the boundary. A 30-degree plane regression recovers the correct normal. |
| 20 | Medium | Rolling shutter read the previous frame's angular velocity before the motion pass updated it. Starts and stops lagged one frame. | Update lens skew in the final lens effect from the motion pass's current output. Cover turns, cuts, pause, and disabled camcorder behavior. |
| 21 | Medium | Zero, negative, or non-finite frame deltas could retain blur and invalid motion history; a zero maximum radius still enabled the blur path. | Treat invalid/non-positive deltas as cuts, sanitize the timestep, and bypass blur at zero radius. Regressions cover each case. |
| 22 | Medium | Dynamic resolution lowered pixel count during CPU streaming stalls even when GPU timings showed ample headroom, adding target reallocations without relieving the cause. | With valid GPU timing, only GPU overload triggers downscaling. CPU load still blocks upscaling. Preserve the existing fallback for devices without timers. |
| 23 | Medium | Timer-query disjoint events dropped only available results, allowing pending invalid results into the next epoch. Ring wrap could also publish an older result last. | Drop every pending result and reset history on disjoint; poll in chronological ring order. GPU profiling also resets its sample window, and benchmarks restart after recovery with bounded waiting. Tests cover delayed invalid results, sample denominators, benchmark recovery, and wrap order. |
| 24 | Low | Offscreen dust performed atlas/cookie/shadow reads; disabled chromatic aberration made five identical taps; disabled volumetrics still planned atlas/mist/mote work; probe refresh rebuilt fixed GGX kernels. | Reject clipped dust centers before lighting reads, use one lens tap at zero CA, skip disabled volumetric planning, and cache probe kernels by resolution. Synthetic dust coverage rejects over 75% before lighting lookups; runtime costs are measured below. |
| 25 | Medium | The six-frame water-plane cache survived storey changes and large position jumps, briefly mirroring a previous location's plane during traversal. | Force a scan after storey changes, displacement over 3 m, or planar-quality changes. Preserve the normal six-frame cadence. The loop regression verifies the selected plane before post-processing. |

The descending-ramp correction follows the [GLSL ES 3.00 specification](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf), which defines `smoothstep` only for ascending edges. The wet-metal correction follows the installed Three r186.1 physical lighting shader, where the direct and environment F0 carriers differ.

## GPU measurements

Measured on Chromium 153 through ANGLE/Vulkan on an NVIDIA GeForce RTX 5070 Ti Laptop GPU. The viewport is 1280 x 800. High uses a 1280 x 800 buffer; ultra uses 1792 x 1120. Baseline and changed builds use identical seeds, positions, frozen time for the isolated benchmark, and the same 8 m walking path for the live profile.

`gpuBench(12)` reports the median of seven rounds, each rendering twelve copies of the current pipeline. The live profile uses two seconds idle and three seconds during the walk. Timings are GPU milliseconds, not end-to-end frame times or FPS. A single before/after pair cannot establish small changes independently of GPU clocks and driver scheduling.

| Scene | Isolated baseline | Isolated changed | Idle baseline | Idle changed | Walking baseline | Walking changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Poolrooms, seed 7, high | 2.441 | 2.494 | 3.238 | 3.324 | 3.229 | 3.429 |
| Lobby, seed 7, high | 1.965 | 2.054 | 2.581 | 2.915 | 2.576 | 2.931 |
| Parking, seed 3, ultra, flashlight | 4.101 | 4.268 | 4.638 | 4.898 | 4.733 | 4.880 |

The isolated benchmark increased by 2.2%, 4.5%, and 4.1% in these scenes. The coherent rough-probe update adds work every fourth frame. Its average live cost rose from 0.205 to 0.286 ms in Poolrooms, 0.242 to 0.478 ms in Lobby, and 0.381 to 0.476 ms in Parking. Stream-triggered full refreshes avoid publishing intermediate cubes and avoid redundant partial filtering. The fixed probe kernels also remove repeated CPU sample generation.

The RGB-throughput attachment adds eight bytes per buffer pixel, about 15.8 MiB at a 1920 x 1080 buffer, or 31.0 MiB at ultra's 1.4x scale for that viewport. It also adds one composite texture fetch and increases scene color attachment write traffic from three attachments to four. Low and medium retain their plain rendering paths and do not allocate it. RGBA8 was rejected because quantization around small dielectric weights creates substantial relative error.

Atomic lightmap swaps temporarily retain one additional map set per in-progress tile swap, approximately 3.70 to 14.20 MiB for the current atlas layouts with all optional channels. Memory statistics count staged resources. Old sets return to the bounded texture pool for reuse; cancellation, restart, disposal, and upload failures release abandoned staging.

## Verification

- `npm test` passed in 77.43 seconds. 155 files passed, one file was skipped; 1,709 tests passed and five were skipped. This includes full sweeps, optical/shader regressions, frame-order checks, timer recovery, and streaming cancellation.
- `npm run build` passed both TypeScript checking and the production Vite build. Vite retains its existing large-chunk warning for the main bundle.
- Final GPU screenshots in Poolrooms high, Lobby high, and Parking ultra with flashlight produced no app or page errors. The fixed shaders compiled on the actual WebGL2 backend.
- Live runtime checks cycled low, medium, high, ultra, medium, and high; resized the viewport through 853 x 479, 640 x 360, 1280 x 800, and 1279 x 799; toggled SSR off/on; and entered and exited the water debug view. Rendering produced no page or console errors. An initial QA command used the invalid view name `lit`; repeating debug restoration with the correct `final` name produced no app warnings or errors.
- Flashlight-on camera turns and an 8 m walk completed without app errors, stalls beyond the 60 Hz frame interval, or a stuck controller. The motion recording and extracted frames were inspected for missing draws, black frames, broken water/reflections, and obvious brightness discontinuities. This is a qualitative check, not a proof that all temporal shimmer is absent.
- `git diff --check` passed.

Artifacts from this session live in `/tmp/backrooms-render-audit/`: baseline and changed screenshots, isolated/live GPU reports, runtime checks, and motion footage. These temporary artifacts are evidence for this run and are not committed game assets.

Reproduce the key views with the existing capture tools:

```sh
node tools/shoot.mjs --fresh --no-memo --size 1280x800 --params 'seed=7&zone=POOLROOMS&quality=high&noaudio=1&time=10&hud=0' --out /tmp/render-pool
node tools/shoot.mjs --fresh --no-memo --size 1280x800 --params 'seed=7&zone=LOBBY&quality=high&noaudio=1&time=10&hud=0' --out /tmp/render-lobby
node tools/shoot.mjs --fresh --no-memo --size 1280x800 --params 'seed=3&zone=PARKING&quality=ultra&flashlight=1&noaudio=1&time=10&hud=0' --out /tmp/render-parking
npm test
npm run build
```

In the debug console, use `await __backrooms.gpuBench(12)`, `await __backrooms.gpuProfile(3)`, and `await __backrooms.autowalk({distance:8,speed:2})` to inspect the current view.

## Remaining design limits

SSR has only the visible depth and opaque color of the current frame. Hidden and offscreen objects come from probe or planar fallback, so those transitions remain approximate. The room probe is staggered over faces and refreshes moving content at a bounded delay. These fixes make its published mip data coherent; they do not make it a simultaneous six-camera capture.

Motion blur reconstructs camera motion from depth. It has no per-object velocity buffer, so moving sparks, props, and other independent motion do not receive physically complete blur. There is no temporal antialiasing or temporal SSR accumulation. Fine subpixel geometry and very bright light streaks can still shimmer under SMAA and spatial reflection filtering. Adding velocity buffers and temporal history would require separate work on disocclusion, translucent water, streaming changes, and camera cuts, with GPU and ghosting measurements.

The new attachment and coherent probe filtering deserve follow-up measurements on integrated and mobile GPUs. This audit validates one desktop GPU backend; it does not replace cross-device testing.
