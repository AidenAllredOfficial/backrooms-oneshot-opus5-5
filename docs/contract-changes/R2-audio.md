# Contract changes — R2 audio (batch B8: ballast buzz, loudness, UI sounds, foley, interactions)

Goal: the defining Level 0 sound (a bright buzzing fluorescent ballast) and a mix at a normal listening level. The
architecture is unchanged: propagation, room probe, per-zone beds, flicker transients, loop-exact synthesis and the
seam test. No `src/core/*` contract changed; everything here is internal to `src/audio`. STATUS.md rows are left to
the orchestrator.

## 2026-09-25 — Hum: bright magnetic-ballast buzz (dsp/hum.ts)
- **Before:** harmonics of 2 x mains stopped at 1.2 kHz (`kMax = floor(1200 / f0)`) and the buzz band sat 30-40 dB
  under them. Offline analysis gave a centroid of 171-210 Hz, 62-82 % of the energy below 150 Hz and 0.1-0.3 % in
  1.2-6 kHz: a dull low drone.
- **Source spectrum:** `kMax = floor(5000 / f0)` (clamped below 0.45 x sr). Amplitude is k^-1.2 up to the 4th
  harmonic, then (k/4)^-0.8. Odd harmonics get +3 dB (magnetostriction asymmetry). Per-ballast jitter is +-2 dB, or
  +-3 dB above 1 kHz. `humHarmonicAmp(k, tilt)` is exported.
- **Housing transfer (new):** what reaches the air is shaped by the troffer. Its small steel box radiates the 120 Hz
  fundamental poorly (first-order high-pass at 220 Hz). The panels ring broadly at 560-900 Hz, set per variant
  (+8 dB, Q 1.2), and their mass rolls the top off (second-order low-pass at 1.6 kHz). Without this, the specified
  k^-0.8 tail either left the centroid under 400 Hz or put 40-50 % of the A-weighted energy above 1.2 kHz, which is
  shrill and fatiguing.
- **Buzz:** 2-6 kHz circular noise band at 0.3-0.5 per variant (was 0.06-0.17), gated at 2 x mains by s^2 (was
  s^4).
- **Loose laminations:** a per-sample asymmetric soft clip on the peak-normalized sum,
  `tanh(drive * (x + 0.15 x^2))` with drive 1.2-1.45 per variant (1.3 typical), then exact mean removal. The map is
  memoryless, so the loop stays exactly periodic. The loop is still rotated to its quietest seam and normalized to
  0.9 peak.
- **Result** (ch 0, 6 s loops, Welch): centroid 469-532 Hz at 60 Hz mains and 542-614 Hz at 50 Hz. The A-weighted
  share of 1.2-6 kHz is 17-22 % (target 12-25 %). Seam deltas are < 2e-4. Energy below 150 Hz is 18-46 %.
- **Test:** `tests/audio/dsp.test.ts` "bright ballast buzz @ 60/50 Hz" asserts, for all 4 variants: centroid
  > 400 Hz, A-weighted 1.2-6 kHz share within 12-25 %, and the harmonic nearest 2.4 kHz at least 4x above the noise
  between harmonics. The existing loop-seam and "fundamental is 2 x mains" tests are unchanged and pass.

## 2026-09-25 — Hum levels (humVoices.ts)
- The new buffers are about 6.5 dB louder A-weighted than the old ones at the same 0.9 peak. `HUM_GAIN` goes from
  0.1 to 0.067 and `BED_GAIN` from 0.08 to 0.055 (-3.5 dB). Net effect: the hum sits about 3 dB more present against
  the beds than the old drone, without a full +6.5 dB of added brightness.
- The hum bed low-pass goes from 1.4 kHz to 2.6 kHz (`BED_LOWPASS`). The plenum still darkens distant fixtures, but
  their buzz stays audible.

## 2026-09-25 — Loudness, output chain and perceptual sliders (graph.ts)
- **Before:** about -26 dBFS RMS walking in Level 0 and about -30 in the Poolrooms, peaks around -15 dBFS. The
  compressor (-18 dBFS) was almost never reached, and the sliders were linear gains.
- **Sliders:** `sliderGain(v) = v^2` (exported). 0 mutes, the default 0.8 is -3.9 dB and 0.5 is -12 dB. The ui bus
  ignores the master *fade* (the title fades master to 0 while its menu clicks must stay audible) but follows the
  user's own Master slider: `AudioEngine` tracks it from the initial settings and `settingsChanged`, and passes it
  as `graph.setVolumes(v, uiMaster)`. Master = 0 therefore mutes the menu sounds too (verifier fix; before, they
  kept playing at Master 0).
- **Make-up:** `post` gain = `MAKEUP_DB` = +15 dB in front of the compressor. This includes the 3.8 dB the
  perceptual sliders take at their defaults.
- **Compressor:** threshold -14 dBFS (was -18), 3:1, knee 6. It only catches loud events.
- **Limiter:** threshold -2.5 dBFS (was -1), ratio 20, 1 ms attack, then a -0.5 dB trim (was -0.3). This leaves
  headroom for inter-sample peaks. `calibrate()` measures the compressors with the same constants.
- **Measured in-app** (`tools/shoot.mjs`, autostart, `window.__backrooms.autowalk`, 10 s output-meter windows):
  - seed=1 Level 0 walking: -18.8 to -20.2 dBFS RMS, peaks -7.1 to -11.1 dBFS (before: -24.5 to -27.8 RMS, peaks
    -15 to -17).
  - seed=7 zone=POOLROOMS: -19.1 to -23.4 RMS, peaks -3.8 to -11.8 (before: -27.5 to -33.5, peaks -13.7 to -22.3).
  - True peaks stay under -2 dBFS.

## 2026-09-25 — Interface sounds (uiSounds.ts, dsp/oneshots.ts)
- **Problem:** nothing subscribed to the GameBus `ui` event, so the Interface slider did nothing.
- `UiSounds` (created in `AudioEngine.build`) subscribes to `ui {hover | click | open | close}` and plays on
  `buses.ui` whenever the AudioContext is `running`. Its 8 buffers (4 kinds x 2 variants, about 1.2 s in total) are
  rendered synchronously on the main thread at start, so the first menu click after the context runs is audible
  without waiting on the DSP worker.
- New one-shot kinds: `uiHover` is a 2-3 ms jog-dial tick near 3 kHz. `uiClick`, `uiOpen` and `uiClose` are a
  camcorder transport key clunk plus a short tape-mechanism whirr with gear chatter. The whirr spins up for open and
  spins down onto a latch for close.
- **Levels** at the default sliders (Interface 0.6, Master 0.8): hover about -32 dBFS (RMS over its 3 ms), clunks
  about -22 dBFS (RMS over their first 100-300 ms). Gains are specified at the speakers and divided by the make-up
  and the default Master gain.
- **Verified in the browser** (shoot eval, autostart): clicking the settings-panel tabs logs `ui click` with the
  context `running` in Level 0, the Poolrooms, and at quality=low and ultra.
- Hover ticks closer than 45 ms apart are dropped. Playback rate varies by +-2 %. Non-hover sounds are logged as
  `ui <name>` in `recentEvents()`.
- **Dependency on B7:** App.ts must call `audio.start()` on the first title gesture; it already emits `ui`.

## 2026-09-25 — Carpet footsteps (dsp/footsteps.ts, footsteps.ts)
- **carpetHit:**
  - Fibre fizz goes from 0.063 to 0.11 on the heel and 0.14 on the toe (about -17 dB).
  - New 400-2500 Hz band-passed drag/scuff (35-80 ms, grainy) starts 40-90 ms after the heel.
  - The toe's pile noise low-pass rises from 800 Hz to 1300 Hz, and its thump is softer.
  - The fizz is lower than the requested ~0.2. At 0.2 the carpet centroid reaches about 780 Hz, which breaks the
    tile > concrete > 3 x carpet ordering test and sounds like a hard floor.
  - **Result:** carpet centroid 183 Hz -> 535 Hz (concrete 2313, tile 2642). carpetWet goes 511 -> 877 Hz.
- **Walk gait gain:** 0.6 -> 0.75.
- **Damp carpet:** on CARPET, the cell humidity is read from the resident layout (`layout.humidity`, the same field
  that grows damp stains). The share of carpetWet steps rises smoothly from 0 at humidity 0.58 to 85 % at 0.8.
- **Tests:** "carpet is soft but not dull" (centroid 350-700 Hz; scuff band energy at 40-130 ms is more than 3x the
  tail). The centroid-order test is unchanged and passes.

## 2026-09-25 — Cloth rustle (foley.ts)
- **Problem:** the rustle followed mouse yaw (0.8 x yawRate / 5), which put a 2.4 kHz hiss on every look.
- **New drive** (target = 0.35 x ...):
  - walking: speed / 3.2 x (0.2 + 0.5 x stepKick), where each footstep adds a kick that decays over 160 ms, so it
    swishes once per step;
  - crouch transitions: unchanged;
  - turning: yaw rate, smoothed over 60 ms, only above 4 rad/s, reaching a capped share of 0.25 at 8 rad/s.
- **Timing:** 150 ms attack and 350 ms release (was 60 ms both ways). Band-pass centre 2.4 kHz -> 1.8 kHz.
  `Foley.onStep(intensity, settle)` is called from the engine's footstep handler.
- **Test:** 2.5 rad/s mouse-look while standing is silent. A 12 rad/s whip turn is audible but at most
  0.35 x 0.25. Steps and a crouch drive it above 0.1.

## 2026-09-25 — Interaction loops (oneShots.ts, emitters.ts, dsp/oneshots.ts)
- **PHONE:** the pick-up clunk plays, then 0.12 s later `phoneLine` (4.8 s, positional, refDistance 2.5), and the
  ringing emitter is silenced as before. `phoneLine` is:
  - a 350 + 440 Hz dial tone through a carbon-earpiece model (300-3400 Hz band, asymmetric saturation);
  - line hiss and a trace of 60 Hz crosstalk;
  - after about 3.1-3.5 s the exchange drops the tone with a click, and the hiss fades out.
- **RADIO:** `Emitters.cycleRadio(x, z, r)` returns `'tune' | 'off' | 'on' | 'none'`.
  - Each press sweeps the dial: the `radioTune` one-shot (0.9 s of band static, a heterodyne whistle gliding through
    zero-beat, and two snatches of band-passed "other station" babble) plays while the loop crossfades. The old
    station is cut in 60 ms, and the next of the radio's 4 station renders fades in after 0.5 s.
  - After the 4th station, the next press clicks it off. The press after that clicks it back on and tunes in.
  - Station state is per emitter key, so a radio that has not been voiced yet starts on its current station.
  - A voiced radio queues its other stations at low priority.
  - Emitter slots now have a per-source `srcGain` between the loop and the voice.
- **Tests:** the engine test cycles a radio through 4 distinct station buffers, then off, then on, and checks that
  the phone line starts 0.12 s after pick-up.

## Offline analysis (`/tmp/uxcritic/audio/analyze.mjs`)
```
HUM 60 Hz  v0 centroid 532 Hz  1.2-2k A 12.7 % + 2-6k A 5.2 %   (before 197 Hz, 1.1 % + 0.6 %)
           v1 469 Hz  11.5 + 7.6 %   v2 473 Hz  12.6 + 4.9 %   v3 502 Hz  12.6 + 5.0 %
carpet     centroid 535 Hz (before 183 Hz)
```
