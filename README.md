# Backrooms

A first-person walking simulator set in an endless, procedurally generated backrooms. It runs in the browser
(TypeScript, three.js, WebGL2). The world is generated around you as you walk and is the same every time for a given
seed. Its three storeys are Level 0 (yellow wallpaper and damp carpet), an industrial Sublevel and the Poolrooms.
Lighting is baked into directional lightmaps on background workers, and the image is graded to look like a cheap
camcorder. There are no enemies, no objectives and no jump scares. You walk, listen to the hum, and find rooms.

## Requirements

- Node.js 24 (developed on 24.19). The `node tools/*.ts` scripts rely on Node's built-in TypeScript type stripping.
- A desktop browser with WebGL2 and the `EXT_color_buffer_float` extension, on a real GPU. The game is developed and
  tested in Chromium (Chrome, Edge). With a software renderer (SwiftShader, llvmpipe) the `auto` quality falls back
  to `low`.
- For the screenshot and QA tools only: Chromium at `/usr/bin/chromium` (or set `CHROMIUM=/path/to/chromium`).

## Running

```sh
npm install
npm run play         # build, serve the production bundle and open it in its own Chromium window on the fast GPU
```

`npm run play` is the recommended way to play on Linux. It serves the production build (it boots faster than the dev
server) and opens a separate Chromium window on the discrete GPU (see [Performance](#performance)). Closing the
window stops the server. `npm run play -- --no-open` only serves it; `npm run play -- --dev` uses the dev server.

For development:

```sh
npm run dev          # Vite dev server with hot reload, prints the URL (http://localhost:5173/ unless that port is taken)
```

Open the printed URL, choose **Enter** on the title screen, and click the view to capture the mouse.

Production build:

```sh
npm run build        # type-check, then build into dist/
npm run preview      # serve dist/ locally (http://localhost:4173/)
```

`dist/` uses relative asset paths, so it can be hosted from any sub-directory as static files.

## Controls

| Input | Action |
|---|---|
| W A S D or arrow keys | Walk |
| Mouse | Look (click the view to capture the pointer) |
| Shift | Run (hold, or toggle: Settings > Comfort > Sprint) |
| C | Crouch (hold, or toggle: Settings > Comfort > Crouch). In fullscreen, Ctrl also crouches. |
| F | Flashlight |
| E | Use: doors, phones, radios |
| Esc | Pause menu |
| F3 | Stats overlay |

Gamepad (standard mapping): left stick walks, right stick looks, A uses, X toggles the flashlight, B crouches,
RT or L3 runs, Start pauses.

Debug keys work only when the page is opened with `debug=1`, `fly=1` or `view=...`: F4 cycles the debug views, and
Space ascends in fly mode.

Outside fullscreen, Ctrl is not a crouch key, because the browser keeps Ctrl+W, Ctrl+S and similar shortcuts.
In fullscreen (from the title menu, the pause menu or Settings > Video), browsers that support the Keyboard Lock API
(Chromium) pass Ctrl to the game.

**Title menu:** Continue (the last saved position), Enter, Seed (type a seed and press Enter, or pick a random one),
Camcorder on/off, Settings, Controls, Fullscreen.

**Pause menu:** Resume, Settings, Controls, Fullscreen, Copy location link (a URL that reopens this exact spot), New
tape (a new seed), Quit to title. The pause screen also shows a log of the zones, landmarks and storeys you have found
on this seed.

## Settings

Settings are saved in the browser's `localStorage`.

- **Video:** quality preset, render scale, dynamic resolution, field of view, brightness, fullscreen.
- **Film:** camcorder overlay (REC, tape counter, date stamp, looser handheld motion), grain, chromatic aberration,
  vignette, lens distortion.
- **Comfort:** head bob, camera shake, walk pace (slow / normal / brisk), flickering lights (standard / reduced / off;
  standard stays under 3 flashes per second), hold-or-toggle for sprint and crouch.
- **Audio:** master, ambience, fluorescent hum, effects and interface volume; mains frequency (50 or 60 Hz).
- **Controls:** mouse sensitivity, invert Y, and the key reference.

### Quality presets

`auto` (the default) picks `low` for software renderers and weak integrated GPUs (Radeon 610M, Intel UHD / HD Graphics),
`medium` for other integrated GPUs (Radeon 680M / 780M / 890M, Iris Xe, Arc Graphics) and entry-level discrete cards,
and `high` for everything else.

| | low | medium | high | ultra |
|---|---|---|---|---|
| Streaming radius (chunks of 38.4 m) | 1 | 2 | 2 | 3 |
| Lightmap texels per 1.2 m cell | 8 | 8 | 12 | 12 |
| Texture size | 512 | 1024 | 1024 | 1024 |
| Ambient occlusion (half resolution, samples per texel) | off | 10 | 12 | 16 |
| Anti-aliasing | off | SMAA | SMAA | SMAA |
| Surface shader detail | lite | full | full | full |
| Bake workers (max) | 3 | 4 | 4 | 6 |
| Water reflections | off | on | on | on |
| Render scale | 0.75 | 0.9 | 1.0 | 1.5 (supersampled) |

Every preset uses dynamic resolution unless you turn it off. It budgets for at least 11 ms per frame, so on a
high-refresh display it only lowers the resolution when the frame rate would drop toward 60 fps (each change resizes
every render target: under GPU compositing that costs a frame or two, under software compositing up to ~150 ms, see
Performance). Changing the texture size needs a page reload (the settings panel says so). The
full table is in `src/core/quality.ts` and `docs/DESIGN.md` section 6.4. "Lite" surface detail drops the per-pixel
world features (anti-tiling blend, macro variation, carpet blotches and pile sheen, wallpaper fades); on a 2-CU
Radeon 610M it roughly halves the cost of the world pass.

## Performance

**Laptops with two GPUs (Linux).** Chromium on Linux ignores WebGL's request for the high-performance GPU. On a
laptop with an integrated and a discrete GPU it can render on the integrated one: on the development laptop that
was a Radeon 610M (13 fps at high) instead of the RTX 5070 Ti (160 fps). The title screen shows a note when the game
runs on an integrated GPU. Ways to use the discrete GPU:

- `npm run play` (recommended). With the NVIDIA driver it starts Chromium with PRIME render offload
  (`__NV_PRIME_RENDER_OFFLOAD=1`, NVIDIA's GLX/EGL vendor) and the default OpenGL backend; with Mesa it uses
  `DRI_PRIME=1`; otherwise it falls back to ANGLE's Vulkan backend. On a Wayland desktop it runs the window through
  XWayland (see below). It uses its own browser profile in `~/.cache/backrooms-chromium`, so your normal Chromium
  profile and settings are untouched, and it works while your normal Chromium is open.
- Your own browser: start it on the discrete GPU, for example
  `__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia chromium --ozone-platform=x11`, or your desktop's
  "Launch using Discrete Graphics Card" / "Run with NVIDIA GPU" menu entry (flags and environment only apply when the
  browser starts, so close it first). `chrome://flags` → "Choose ANGLE graphics backend" → Vulkan also selects the
  discrete GPU.

**Wayland desktops (Linux).** Chromium's native Wayland backend fell back to software compositing on the development
laptop with every GPU and backend (`chrome://gpu` → "Compositing: Software only"). The game still renders on the GPU,
but every frame is read back to the CPU and composited there, which serialises the CPU and GPU: at ultra and 165 Hz it
ran at 94 fps standing and 79 fps walking, and each dynamic-resolution change stalled for 100-160 ms. Under XWayland
(`--ozone-platform=x11`) compositing is hardware accelerated: 149 fps standing, 128 fps walking, and a resolution
change costs at most 18 ms. `npm run play` uses XWayland whenever it is available (`BACKROOMS_OZONE=wayland` keeps
the native backend); for your own browser, add `--ozone-platform=x11` or set `chrome://flags` → "Preferred Ozone
platform" to X11.

**Loading.** The world is ready once the tiles within 20 m of you, and the tiles in view within 40 m, have their
first (preview) lighting; the rest of the streaming radius fades in behind the haze and the full-quality lighting
swaps in over the next seconds. Nearby geometry and preview lighting start while textures and shaders initialize.
Loading another seed keeps the renderer, textures, compiled shaders and synthesized audio. In the September 2026
audit, seed changes reached ready in about 2 s; opening a fresh page took about 6 s. The light baker is
memory-bandwidth bound, so more worker threads do not help:
4 workers reached ready faster than 10. Screenshot and QA runs (`autostart=1`) still wait for full lighting on the
whole 3 x 3 chunk ring so their images are deterministic; `bake=preview` / `bake=interactive` give the player gate.

**GPU cost.** On the development laptop (RTX 5070 Ti) a frame at high and 1080p costs about 1.6-2 ms of GPU time,
and ultra at 1440p (a 3840 × 2160 supersampled buffer) about 6-7 ms. The scene is drawn with a depth prepass (each
visible pixel is shaded once; the image is identical), and ambient occlusion runs at half resolution.
`__backrooms.gpuBench()` measures the current view, `__backrooms.gpuProfile(seconds)` splits it by pass.

See [the performance audit](docs/PERFORMANCE_AUDIT.md) for measurements, changes and reproduction steps.

**First-context loss.** Under native Wayland, Chromium on this laptop loses the first WebGL context of a fresh
browser session on the NVIDIA GPU and restores it about a second later: that is the GPU process restarting after GPU
compositing failed. The game absorbs it on a throwaway context before creating its own (once per tab), so textures
and shaders are not built twice. Under XWayland the loss does not happen, and `npm run play` skips the wait
(`noprime=1`, about 0.55 s off the boot).

## The world

- **Grid.** The world is made of 1.2 m cells with thin walls on the cell edges. It is generated and streamed in chunks
  of 32 x 32 cells (38.4 m), and each chunk is split into four render and bake tiles.
- **Districts and zones.** Each storey is divided into Voronoi districts of about 150 m, and each district gets one of
  12 zones. Level 0 zones: LOBBY, MANILA, DARK, MAZE, LOW_EXPANSE, PILLAR_HALL, OFFICE. Deep zones: POOLROOMS,
  PARKING, PIPEWORKS, WAREHOUSE, CONCRETE. Continuous power, decay, humidity and warmth fields run across district
  borders, so dead lights, water damage and colour drift change gradually. District moods (normal, sparse, dying,
  dark) vary the lighting.
- **Storeys.** There are three storeys:
  - storey 0, Level 0: mostly LOBBY;
  - storey 1, the Sublevel: PARKING, PIPEWORKS, CONCRETE, WAREHOUSE;
  - storey 2, the Poolrooms: mostly POOLROOMS.

  Stair towers and elevators connect them. Going down from storey 2 brings you back to Level 0, so the building never
  ends.
- **Content.** 38 landmark kinds (for example SKYLIGHT_HALL, LOCKER_ROOM, CHAIR_CATHEDRAL, FLOODED_HALL, RED_ROOM),
  13 small vignettes (a chair facing a wall, a ringing phone, an open car), anomalies, and props.
- **Lighting.** A worker pool bakes the lighting per tile: direct light from every fixture, indirect light via probes,
  and ambient occlusion. A fast preview bake appears first and the full bake replaces it. The flashlight is the only
  runtime light. Flickering fixtures are driven by shader uniforms on top of the baked result.
- **Audio.** All sound is synthesized: fluorescent hum, footsteps by surface, room reverb, and sounds that bend
  around doorways.

`docs/DESIGN.md` has the full design.

## URL parameters

Add parameters to the page URL, for example `http://localhost:5173/?seed=7&zone=POOLROOMS&quality=high`. Unknown or
invalid values never break the page. They are listed in the F3 overlay's warnings. The full list is in
`src/app/urlParams.ts` and `docs/DESIGN.md` section 7.1.

| Parameter | Values | Effect |
|---|---|---|
| `seed` | any text | World seed. Default: the last seed you played, otherwise a random one. |
| `autostart` | `1` | Skip the title screen (used by the tools). |
| `s` | `0`, `1`, `2` | Storey. |
| `x`, `z` (`y`) | metres | Start position. Without `y` you are placed on the floor. |
| `yaw`, `pitch` (`yawDeg`, `pitchDeg`) | radians (degrees) | Start view direction. |
| `fov` | 50-90 | Vertical field of view. |
| `goto` | `zone:NAME`, `landmark:NAME`, `vignette:NAME`, `tower`, `elevator`, `dark`, `water`, `flicker`, `spawn` | Start at the nearest match, facing its best view. |
| `zone` | zone name | Short for `goto=zone:NAME`. |
| `forceZone`, `forceMood`, `forceLandmark` | zone / mood / landmark name | Make every district that zone or mood, or stamp a landmark at chunk (0, 0). |
| `testScene` | `leak`, `cornell`, `tower`, `materials`, `flicker`, `grid` | A hand-built test scene. |
| `quality` | `low`, `medium`, `high`, `ultra`, `auto` | Quality preset for this session. |
| `scale`, `radius` | 0.5-2, 1-4 | Render scale and streaming radius overrides. |
| `camcorder` | `1` | Camcorder overlay on. |
| `flashlight` | `1` | Start with the flashlight on. |
| `flicker` | `standard`, `reduced`, `off` | Flicker mode. |
| `lights` | `default`, `on`, `dead` | Force every fixture on or dead. |
| `time`, `freeze` | seconds, `1` | Freeze the clock (flicker, grain, water) at a time. |
| `exposure` | EV100 or `auto` | Lock the exposure. |
| `noaudio` | `1` | No audio. |
| `nopost`, `ao`, `bloom`, `grain`, `lens` | `1` / `0` | Turn the post stack off, or individual effects off. |
| `ssr`, `probe`, `cs`, `bounce`, `vol` | `0` | Turn a graphics-realism feature off for A/B checks: screen-space reflections, reflection probe, contact shadows, flashlight bounce, volumetric haze. |
| `reflView` | `ssr`, `conf` | Screen-space reflection debug output: the reflection alone, or its confidence. |
| `view` | `final`, `albedo`, `normal`, `lightmap`, `ao`, `zone`, ... | Debug view. |
| `fly` | `1` | Noclip flight (Space ascends). |
| `hud`, `debug` | `0`, `1` | Hide all overlays; open the F3 overlay at start. |
| `bake`, `bakeTerm` | `preview`/`full`/`interactive`, `all`/`direct`/`indirect` | Bake level required before the page reports ready; bake debugging. |
| `noprime` | `1` | Skip the wait for Chromium's first-context loss at boot (`npm run play` sets it under XWayland, where that loss does not happen). |

Examples:

```
?seed=7&goto=landmark:CHAIR_CATHEDRAL
?seed=3&goto=tower&flashlight=1
?seed=1&zone=PARKING&camcorder=1
?seed=7&s=2&x=242.4&z=166.7&yaw=-2.345&pitch=-0.25
```

## Developer tooling

```sh
npm test             # vitest, all tests in tests/ (at most 2 worker processes, see vite.config.ts)
npx vitest run tests/world         # one directory
npm run typecheck    # tsc --noEmit
```

### Screenshots: `tools/shoot.mjs`

Starts its own Vite server, loads each URL in headless Chromium (GPU through ANGLE/Vulkan) with `autostart=1`, waits
until the world is ready (textures, shaders, full bakes around the player), and saves a PNG. It prints a JSON report
with console errors and `window.__backrooms.stats()` for every shot.

```sh
node tools/shoot.mjs --out /tmp/shots --size 1920x1080 \
  --params "seed=7&zone=LOBBY&quality=high&time=10&noaudio=1" \
  --params "seed=7&goto=landmark:LOCKER_ROOM&quality=high&time=10&noaudio=1"
node tools/shoot.mjs --page harness/chunk.html --params "seed=1&cx=0&cz=0&view=lightmap"
node tools/shoot.mjs --params "seed=1&quality=high&noaudio=1" --eval "__backrooms.perf(10)"
```

Options: `--params` (repeatable), `--out` (default `shots/`), `--size` (default 1600x900), `--wait` (ms after ready,
default 250; the frame at ready is already final), `--eval` (JS evaluated in the page; the result goes into the
report), `--page`, `--preset`, and `--url` (use a server that is already running).

Put several `--params` in one call. Each call starts a browser and a Vite server.

### QA: `tools/qa.mjs`

Runs the named presets from `tools/qa-presets.json` and checks every shot against thresholds: brightness range,
clipping, Level 0 hue, draw calls, readiness time, errors, and per-shot checks. It writes `<out>/qa-report.json` and
exits non-zero if any shot fails.

```sh
node tools/qa.mjs --list
node tools/qa.mjs --preset zones,landmarks --out /tmp/qa
node tools/qa.mjs --preset zones --only 'PARKING|POOLROOMS' --out /tmp/qa-deep
node tools/qa.mjs --preset all --out /tmp/qa-all      # about 40 minutes
```

Presets: `zones`, `spawn`, `leak`, `cornell`, `views`, `dark`, `pools`, `tower`, `landmarks`, `materials`, `post`,
`perf`, `soak` (1.5 km autowalk with memory checks), `stress` (50 teleports), `edge`, `decals`, `ui`.
`--baseline dir` compares each image with an earlier run; the result is reported but never fails a run.

### QA speed and the result cache

Screenshot and QA runs (`autostart=1`, bake level `full`) wait until the 36 tiles around the player are fully baked.
Those tiles are built with full lighting straight away and ahead of all other work, uploads skip the per-frame limit
and the fade-in until the page is ready, and a shot is taken 250 ms after ready (the frame is final by then). A shot
reaches ready in about 7 s on a cold cache.

The dev server of a tool run keeps every worker result (layouts, tile builds, full bakes, spawn and `goto` searches)
in `~/.cache/backrooms-tilecache`, so a later shot or run of the same place reuses it: the 36-shot `zones` preset takes
about 4.5 minutes the first time and 1.7 minutes after that (about 1.8 s to ready per shot). Results are keyed by a hash
of every source file the worker runs (world generator, mesher, props, baker), the world and bake settings and the
request, so editing any of them makes the cache miss instead of serving stale data; shader, post and app changes keep
hitting it. Warm runs are also more repeatable: without the cache, distant tiles that are still streaming in can
differ by a few hundred pixels between runs of the same shot. The game itself (`npm run dev`, builds) never uses the
cache.

| Variable | Default | Meaning |
|---|---|---|
| `BACKROOMS_TILE_CACHE` | on for tool runs | `0` disables the cache (every shot computes its own lighting). |
| `BACKROOMS_TILE_CACHE_DIR` | `~/.cache/backrooms-tilecache` | Cache directory (delete it to clear the cache). |
| `BACKROOMS_TILE_CACHE_MB` | 8192 | Size cap; the least recently used entries are removed beyond it (a shot stores about 50 MB). |

### Browser slot and memory gate

Every `shoot.mjs` or `qa.mjs` process first takes a machine-wide slot (a lock directory under
`/tmp/backrooms-browser-slots`). It then waits until the system has enough free memory before starting Vite and
Chromium. Concurrent runs therefore queue instead of exhausting RAM. The environment variables are:

| Variable | Default | Meaning |
|---|---|---|
| `BACKROOMS_BROWSER_SLOTS` | 1 | Browsers allowed at once, machine-wide. |
| `BACKROOMS_MIN_FREE_MB` | 3000 | Free memory (MemAvailable) required before a browser starts. |
| `BACKROOMS_HC` | 8 | `navigator.hardwareConcurrency` reported to the page. This keeps the bake worker pool small (4 workers). |
| `BACKROOMS_EVAL_TIMEOUT_MS` | 900000 | Timeout for one `--eval`. |
| `BACKROOMS_UNCAPPED` | unset | `1`: no vsync or frame-rate cap, so the GPU stays clocked up (steadier in-page timings). |
| `CHROMIUM` | `/usr/bin/chromium` | Browser executable. |

### Showcase video: `tools/showcase.mjs`

Renders scripted walks frame by frame and encodes them with ffmpeg (`FFMPEG=/path/to/ffmpeg`, default
`~/.cache/ffmpeg-static/ffmpeg-7.0.2-amd64-static/ffmpeg`). The tool steps the page's `requestAnimationFrame`
itself, so a slow frame never drops or stutters in the video. It walks the player with a virtual gamepad, which
keeps the game's own head bob, collision and footsteps. It also swaps the game's `AudioContext` for an
`OfflineAudioContext` and renders exactly one video frame of audio per step, so the synthesized sound lines up with
the picture.

```sh
node tools/showcase.mjs scout --targets "landmark:CHAPEL,zone:PARKING" --out /tmp/scout   # stills + ASCII map per spot
node tools/showcase.mjs render --script tools/showcase-shots.json --preview               # 960x540, 30 fps check
node tools/showcase.mjs render --script tools/showcase-shots.json                         # 1920x1080, 60 fps
node tools/showcase.mjs assemble --script tools/showcase-shots.json                       # -> showcase/master/*.mp4
```

`tools/showcase-shots.json` is the shot list: per shot a storey, a timed path `[t, x, z]`, look keys
`[t, yawDeg, pitchDeg]`, and optional captions, title cards, fades, gamepad presses (`press: [[t, button]]`, button
2 toggles the flashlight) and extra stream-settle times (`settleAt`). A shot may change storey on the way: walk into
an elevator cab and hold still, walk down a stair tower, or push into a glitch wall (`push: [[t0, t1, yawDeg]]` holds
the stick into it; `free: [[t0, t1]]` then releases it, because the warp lands somewhere the path cannot know).
`simTime` sets the simulation clock at the start of the shot. Spark bursts, flicker and "light dies" rolls are pure
functions of it (`src/lighting/anomalyDirector.ts`), so a shot can place them. Once a
second the render holds the video clock while the stream still has bakes or uploads pending, so new areas never
appear half-lit. The render prints each shot's maximum path error. A value above a few centimetres means a wall or
prop blocked the walk. Render options: `--only a,b`, `--quality`, `--grain` (default 0.5), `--fps`, `--size`,
`--noaudio`. Assemble options: `--crf`, `--output`.

`tools/showcase-route.ts` plans longer walks on the generator's own data. It builds each chunk's player collision
(`src/player/collisionBuild.ts`), so routes avoid the same walls, props, pillars and raised floors the controller
collides with. Door leaves are the one exception: they are dynamic, so a preview render is still the final check.

```sh
node tools/showcase-route.ts sites --seed 7 --s 0 --at 710,-1557          # landmarks, elevators, stair towers nearby
node tools/showcase-route.ts sites --seed 7 --s 0 --at 0,0 --r 14 --all --only "glitch|CEILING|RINGING_PHONE.*DARK"
                                                                           # + anomalies, vignettes, glitch walls, moods
node tools/showcase-route.ts route --seed 7 --s 0 --from 686,-1566 --via 709.8,-1560.5 --to 710.4,-1549 \
     --speed 1.25 --ease-out --png /tmp/route.png                          # timed path + look keys as JSON
node tools/showcase-route.ts map --seed 7 --s 1 --at -452,-196 --pad 20 --png /tmp/map.png
```

### World and bake tools (Node, no browser)

```sh
npm run map -- --seed 1 --s 0 --cx0 -2 --cz0 -2 --cx1 2 --cz1 2               # ASCII map of 5 x 5 chunks
npm run map -- --seed 1 --s 0 --cx0 -2 --cz0 -2 --cx1 2 --cz1 2 --png map.png # PNG map (4 px per cell)
node tools/map.ts --seed 1 --s 0 --cx0 0 --cz0 0 --cx1 1 --cz1 1 --zones       # zone letters and a district summary
node tools/map.ts --seed 1 --bench 100                                          # chunk generation timing (JSON)
npm run bakebench -- --zones LOBBY,POOLROOMS --quality high                      # light-baker timings and gates
node tools/workerbench.ts 7 42                                                # serial spawn, geometry, preview and full-bake timings
```

`tools/map.ts` also accepts `--force ZONE`, `--mood MOOD`, `--landmark NAME` and `--scene NAME`. `tools/bakebench.ts`
bakes a 3 x 3 chunk neighbourhood of each listed zone. It reports per-tile preview and full bake times, and the
time-to-ready on worker threads (`--workers N`, `--no-ttr`, `--json out.json`). It exits with code 1 when a timing
gate fails.

### Harness pages

With `npm run dev` running, `http://localhost:5173/harness/index.html` links to isolated test pages:

- `harness/materials.html`: the procedural texture gallery (`view=albedo|normal|ormh|lit`, `layer=N`). Its GPU
  checks (`checks=albedo,range,seam,orient`) report layer means against the table, the per-layer albedo percentile
  range (`stats().albedoRange`), the relief maximum against the POM tops (`heightFails`), tiling seams and arrows.
- `harness/chunk.html`: one chunk through the real worker pipeline, with a fly camera (`seed`, `s`, `cx`, `cz`,
  `zone`, `view`, `tpc`, `bake`).
- `harness/post.html`: the post-processing stack on synthetic scenes (`scene=panels|dark|shimmer`).

They are not part of `npm run build` unless you set `BACKROOMS_HARNESS=1`.

### Debug API

The page exposes `window.__backrooms`. It has readiness flags, `stats()`, `teleport()`, `goto()`, `perf(seconds)`,
`gpuBench()`, `gpuProfile(seconds)`, `imageStats()`, `autowalk()`, `ascii()` and world queries. The tools use it, and you can call it from the browser
console. See `src/core/debug.ts` and `docs/DESIGN.md` section 7.2.

## Architecture

The source is in `src/`. The folders below are grouped by role.

**Contracts and generation**
- `core/`: the shared contracts: constants, ids, grid math, the layout format, settings, quality presets, the debug
  API types. Every other module depends on it and it depends on nothing.
- `world/`: the pure, deterministic generator. It builds districts, zones, seams, towers, elevators, landmarks,
  vignettes and spawn points into a `ChunkLayout` per chunk.

**Worker-side building**
- `mesh/`: turns layouts into surface meshes and lightmap charts.
- `props/`: prop geometry.
- `bake/`: the CPU light baker.

These three run in `workers/`.

**Rendering and audio**
- `stream/`: streaming, the worker pool, tile residency and the `WorldQuery` used for collision and gameplay.
- `textures/`: procedural PBR textures generated on the GPU at startup.
- `materials/`: the shader patches on `MeshStandardMaterial`, the depth prepass and the planar water reflection.
- `lighting/`: flicker, atmosphere and haze.
- `post/`: ambient occlusion, exposure, bloom, AgX, grade, lens and grain.
- `audio/`: synthesized sound and propagation.

**Player and app**
- `player/`: input, controller, collision, towers and elevators, and the autopilot used by the title screen and
  autowalk.
- `app/`, `ui/`: boot sequence, frame loop, URL parameters, the debug API, menus and settings.

`docs/DESIGN.md` is the complete design: decisions, module contracts, the frame loop, quality presets, the automation
contract and performance budgets. `docs/contract-changes/` records changes to the core contracts since that design,
and `STATUS.md` indexes them.
