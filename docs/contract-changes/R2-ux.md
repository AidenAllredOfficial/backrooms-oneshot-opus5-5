# Contract changes — R2 UX (batch B7: player and app shell)

Goal: nothing breaks the spell or loses progress, the found-footage framing carries into play, players learn the
controls and notice what they discover. Pointer-lock handling, 120 Hz movement and the comfort settings are kept.
STATUS.md has one row for the core changes.

## 2026-09-25 — `Settings.cameraShake`, `Settings.walkSpeed`, `WalkSpeed` (core/settings.ts, additive)
- **Change:** `cameraShake: number` (0..1, default 0.5) and `walkSpeed: 'slow' | 'normal' | 'brisk'` (default
  `'normal'`). `settingsStore` validates both (clamp / enum fallback). Settings > Defaults resets them.
- **Migration:** settings written before R2 (no `cameraShake` or `walkSpeed` key) whose `mouseSensitivity` is
  exactly the old default 0.0022 get the new default 0.0014. Any other stored value is kept. The v0 migration
  runs first and uses the same rule.
- **Consumers:** player/cameraRig.ts (`RigOptions.cameraShake`), player/PlayerSystem.ts (walk pace),
  ui/settingsPanel.ts.

## 2026-09-25 — `DEFAULT_SETTINGS.mouseSensitivity` 0.0022 -> 0.0014 rad/count (core/settings.ts, value change)
- 0.0022 is about 9 cm per 360° at 800 dpi, which is twitchy for a slow walking game. 0.0014 is about 14 cm.
  The slider range is still 0.0003-0.008, now on a log scale (`RangeRow.log`). The readout shows `1.00×`, and a
  note under it gives cm per 360° at 800 and 1600 dpi. The gamepad look rate is relative to the default, so the
  stick speed at the default setting is unchanged (2.8 rad/s).

## 2026-09-25 — Pace: `PLAYER.walk` 1.45 -> 1.75, `sprint` 3.2 -> 4.0, `sprintTired` 2.4 -> 3.2 (core/constants.ts, value change)
- **Conflict resolved:** found footage suggests slow walking, but the world is sparse and infinite. The walk is
  now 1.75 m/s with `STRIDE.walk` 0.75 m, a cadence of about 2.3 Hz. That is an unhurried pace, not a jog. The
  sprint is 4.0 m/s. `FATIGUE_START` goes from 10 s to 25 s (controller.ts), so the fatigue ramp is 25-30 s.
- **Comfort setting:** Walk pace is Slow 1.45, Normal 1.75 or Brisk 2.0 m/s (`WALK_SPEEDS` in controller.ts).
  It applies only while a human drives the player (`PlayerSystemExt.setUserPace(true)`, which App sets in `play`
  mode when no InputDriver is active). The attract walk (capped at 1.0 m/s) and autowalk / walk
  (`speedToInput` uses `DEFAULT_CONTROLLER.walk`) keep the default config, so their speeds stay exact.
- Tests: controller cadence and fatigue tests updated on purpose; a new test covers the pace setting.

## 2026-09-25 — Handheld camera (player/cameraRig.ts)
- Handheld sway is on by default and independent of the camcorder OSD. It is a slow operator drift (0.12-0.29 Hz)
  mixed with the existing 3-octave hand noise (0.4-1.2 Hz). The typical peak is `cameraShake × 0.3°` (0.15° at the
  default), ×1.35 while walking and ×1.8 while sprinting. Camcorder mode raises this to `cameraShake × 0.5°`, which
  at the default equals the old camcorder value of 0.25°. `cameraShake` 0 removes all sway, including in camcorder
  mode. Under frozen time (`time=`/`freeze=`) there is no sway at all. Before this change, camcorder mode under a
  frozen clock held a fixed offset pose; captures now use the unrotated pose.
- The camcorder default stays **off**. The REC OSD (counter, date, frame) is a strong stylistic choice, and the
  default handheld sway, lens and grade already give the found-footage feel. The camcorder toggle is now a row on
  the title screen (`Camcorder  off`) and in Settings > Film, so players can find it.

## 2026-09-25 — Input safety (player/input.ts, App.ts)
- Ctrl is **no longer crouch** by default. Ctrl+W closes the tab, and Ctrl+S or Ctrl+D open dialogs that break
  pointer lock. Crouch is C. Ctrl crouches only when `setKeyboardLocked(true)` was called (the app does this
  after `requestFullscreen()` and a resolved `navigator.keyboard.lock(KEYBOARD_LOCK_CODES)`) and
  `document.fullscreenElement` is set.
- While the pointer is locked, keydowns with Ctrl or Meta on the game letter keys (`GAME_LETTER_KEYS`) are
  `preventDefault()`ed and do not move the player.
- App: a `beforeunload` guard in `play` and `paused` mode saves the continue point and tape log, then asks
  (`e.preventDefault(); e.returnValue = ''`). The app's own reloads (seed change, New tape, Reload now, Resume
  here) set a `leaving` flag and skip the guard.
- Fullscreen toggles are on the title, in the pause menu and in Settings > Video. Leaving fullscreen unlocks the
  keyboard.
- Debug keys: F4 (debug view) works only with `debug=1`, `fly=1` or a `view=` launch param. The Controls sheet
  lists F3, F4 and Space under a "Debug" heading only with `debug=1`. F3 still toggles the overlay.

## 2026-09-25 — Robustness (App.ts)
- **WebGL context loss:** `setAnimationLoop(null)` stops the frame loop, so the player, streamer, audio updates
  and autowalk all stop. The handler also sets `clock.paused`, calls `audio.setPaused(true)` with the master
  volume at 0, exits pointer lock and saves the continue point (in play or paused mode). While lost, pause() and
  resume() do nothing. The error screen offers **Resume here**, which reloads with
  `locationSearch(seed, s, x, z, yaw, pitch)` and carries over `autostart`, `noaudio`, `quality`, `hud`, `debug`,
  `camcorder`, `bake`, `fly` and `flicker`. It sets the ENTER flag if the player was in play. A
  `webglcontextrestored` event triggers the same reload automatically, because the GPU resources cannot be
  rebuilt in place. Verified: 0 m moved while lost, one error (`WebGL context lost`), and the reload lands on the
  same x/z with no errors.
- **Zero-size window:** a resize to width or height < 1 suspends rendering. A valid size calls
  `post.setSize`, `post.snapExposure()` and re-arms the loop.
- `ui.error(title, message, detail?, action?)`: the optional action replaces the Retry button.

## 2026-09-25 — Discovery and onboarding (App.ts, ui/)
- **First play** (localStorage `backrooms.onboarded.v1`): an OSD strip shows
  `WASD walk · Shift run · C crouch · F light · E use · Esc menu` for 12 s.
- **Captions** in camcorder title-generator style, bottom left, with a type-on effect, for about 3 s. They trigger
  on a zone change (the cell zone must be stable for 1 s, and not while the ready gate is open after a teleport),
  on a storey change, and on the first entry into each landmark instance per session (checked against
  `layout.landmarks` rectangles). Zone captions use display names: `Level 0 — Manila Rooms`, `The Poolrooms`,
  `Sublevel — Pipeworks`. The second line is a date stamp. Landmark captions use the landmark name (`The Red
  Room`) with the place as the second line. Stairwell and elevator cells (structure zone) neither caption nor
  count. There are no captions with `autostart`, `hud=0`, or while an InputDriver is active. On ENTER the tape
  opens with a caption of the current place. Display names are in `ui/names.ts`.
- **Tape log** (`continueStore.ts`: `createTapeLogStore`, localStorage `backrooms.tapes.v1`, at most 24 seeds):
  per seed it stores zones seen (bitmask, shown as x / 12), landmark kinds found (x / `LANDMARK_COUNT`), storeys
  visited (x / 3), metres walked (per-frame steps under 3 m, so teleports are not counted) and tape time (seconds
  in play). It is shown on the pause screen and saved with the continue point, on discoveries, on pause and on
  pagehide.
- **Pause:** the location line uses display names, with the landmark first if you stand in one. Coordinates are
  on a small second line. New menu items: Controls (the key sheet), Fullscreen, New tape (random seed; reloads
  and enters). Resume shows the hint `click`.
- **Esc on the pause menu** hides the menu and shows `Click to resume` at once, without first trying a pointer
  lock that the browser refuses. Esc on that prompt returns to the menu. Any click or non-Esc key resumes.
- **Seed:** a seed committed on the title (Enter or ↻) reloads straight into play (`enter = true`). The seed
  field is part of the arrow-key menu navigation (`navigable` accepts inputs and exposes `move(±1)`).
- **Interaction cue:** OSD corner brackets and `[E] TRY DOOR` / `ANSWER` / `RADIO OFF` fade in over the target
  and replace the 3 px dot. Pressing E gives brief feedback: `Locked`, `No one there`, `Off`, or `Nothing here`
  when nothing is targeted. The cue shows in `play` mode only, so QA captures in `auto` mode never include it.

## 2026-09-25 — Title audio (App.ts)
- The first pointerdown or keydown on the title calls `startAudio()` (not with `noaudio=1` or `autostart`). It
  sets the title gain target to 0.6 (verifier: 0.2 measured ~-58 dBFS rms, too quiet to hear; 0.6 measures ~-39 dBFS, the ~-40 target,
  against ~-20 in play) and applies the existing pause muffle (`audio.setPaused(true)`: 800 Hz
  low-pass, -12 dB), so a distant hum plays under the attract walk. ENTER removes the muffle and keeps the 1 s
  hum lead-in. Quit to title goes back to the muffled title level. Only existing AudioSystem APIs are used.

## 2026-09-25 — Menus and legibility (ui/style.css, ui/settingsPanel.ts)
- `--br-dim` alpha 0.56 -> 0.74 and `--br-faint` 0.3 -> 0.46. `--br-faint` is now used only for decoration.
  Base size is 14 px, menu items 14 px, notes and values 11-12 px, group labels amber 11 px.
- The photosensitivity warning is amber, 12 px, on a 0.8 black backing with an amber rule. Measured contrast on
  the title shot is 10.5:1, up from 3.3:1. Settings group labels measure 8.5:1, up from 2.3:1.
- Settings: Film is its own tab (Video / Film / Comfort / Audio / Controls). The panel height is
  `min(720px, 92vh)`, rows are at least 36 px tall, and a bottom fade mask appears while a tab has more rows below
  the fold. Nothing clips at 1366x768.

## 2026-09-25 — Verifier follow-up (input.ts)
- Ctrl / Meta chords on game letters are still preventDefault()ed while pointer-locked, but WASD now register:
  before, holding Ctrl and pressing W / A / S / D froze the player, which also broke Ctrl-crouch walking in
  fullscreen with a keyboard lock (Ctrl+W was swallowed as a chord). Ctrl+C never counts as crouch outside
  fullscreen + keyboard lock; other chorded letters (E, F, ...) are not added to the held-key set.
