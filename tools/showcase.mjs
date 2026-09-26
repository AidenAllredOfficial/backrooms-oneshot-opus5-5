#!/usr/bin/env node
// Showcase video capture: renders scripted walks through the world frame by frame and encodes them with ffmpeg.
//
//   node tools/showcase.mjs scout --targets "landmark:ATRIUM,zone:PARKING,pos:0:176.5:-6.6:90" [--seed 7] [--out /tmp/scout]
//   node tools/showcase.mjs render --script tools/showcase-shots.json [--out dir] [--only name,name]
//                                  [--fps 60] [--size 1920x1080] [--quality ultra] [--grain 0.5] [--preview] [--noaudio]
//   node tools/showcase.mjs assemble --script tools/showcase-shots.json [--out dir] [--crf 17] [--output file.mp4]
//
// scout: for each goto target, teleports there and saves four views (best view + 90/180/270 degrees), the ASCII
//        map around the spot and the position, so shots can be planned.
// render: for each shot in the script, teleports to its start, waits until every tile around it is fully baked,
//        then switches the page to a virtual clock (requestAnimationFrame is stepped by this tool, 1/fps per frame)
//        and walks the path. The player is driven through a virtual gamepad (left stick, so the controller, head bob
//        and collision are the real ones) and the view through __backrooms.look(). Every frame is screenshotted and
//        piped into ffmpeg (<out>/shots/<name>.mkv, near-lossless). The game's AudioContext is an OfflineAudioContext
//        rendered one frame at a time, so each shot also gets a sample-aligned <name>.wav. --preview renders at
//        960x540 / 30 fps into showcase/preview.
//        Shot options beyond path / look: captions, card, fades, press (gamepad buttons), push / free (glitch walls),
//        simTime (simulation clock at t = 0), settleAt; see the $comment in tools/showcase-shots.json.
// assemble: concatenates the shots in script order into one H.264 / AAC MP4.
//
// Uses the machine-wide browser slot and memory gate from tools/shoot.mjs (one browser at a time).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchBrowser, parseSize, startVite, stopVite, warmGpu, PAGE_HC, withTimeout } from './shoot.mjs';

const FFMPEG = process.env.FFMPEG ?? path.join(os.homedir(), '.cache/ffmpeg-static/ffmpeg-7.0.2-amd64-static/ffmpeg');

function parseArgs(argv) {
  const o = { cmd: argv[0], seed: '7', out: null, targets: [], script: null, only: null, fps: 60, size: '1920x1080', preview: false, quality: 'ultra', grain: 0.5, extra: '', idle: 30000, audio: true };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--seed') { o.seed = v; o.seedSet = true; i++; }
    else if (a === '--out') { o.out = v; i++; }
    else if (a === '--targets') { o.targets.push(...v.split(',').map((s) => s.trim()).filter(Boolean)); i++; }
    else if (a === '--script') { o.script = v; i++; }
    else if (a === '--only') { o.only = v.split(',').map((s) => s.trim()); i++; }
    else if (a === '--fps') { o.fps = Number(v); i++; }
    else if (a === '--size') { o.size = v; i++; }
    else if (a === '--quality') { o.quality = v; i++; }
    else if (a === '--grain') { o.grain = Number(v); i++; }
    else if (a === '--params') { o.extra = v; i++; }
    else if (a === '--idle') { o.idle = Number(v); i++; }
    else if (a === '--preview') { o.preview = true; }
    else if (a === '--noaudio') { o.audio = false; }
    else if (a === '--crf') { o.crf = Number(v); i++; }
    else if (a === '--output') { o.output = v; i++; }
  }
  return o;
}

// ---------------------------------------------------------------- page instrumentation

/** Runs in the page before any game script: settings, virtual gamepad, a steppable requestAnimationFrame and (when
 * audioSeconds > 0) an OfflineAudioContext in place of the game's AudioContext, rendered one video frame per step. */
function pageInit({ hc, settings, audioSeconds }) {
  try { Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => hc }); } catch {}
  try { localStorage.setItem('backrooms.settings.v1', JSON.stringify(settings)); } catch {}
  try { localStorage.setItem('backrooms.onboarded.v1', '1'); } catch {}

  // virtual gamepad (standard mapping): the tool writes axes[0..1] (left stick) every frame
  const axes = [0, 0, 0, 0];
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = { id: 'showcase-virtual-pad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes, buttons, vibrationActuator: null };
  Object.defineProperty(Navigator.prototype, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });

  // offline audio: the game's AudioContext becomes an OfflineAudioContext whose clock only moves inside step()
  const SR = 48000, QUANTUM = 128 / SR;
  const audio = { ctx: null, started: false, rendered: null, error: null };
  if (audioSeconds > 0) {
    const Offline = window.OfflineAudioContext;
    window.AudioContext = function CineAudioContext() {
      const ctx = new Offline({ numberOfChannels: 2, length: Math.ceil(audioSeconds * SR), sampleRate: SR });
      ctx.close = () => Promise.resolve();
      audio.ctx = ctx;
      return ctx;
    };
  }
  const advanceAudio = async (target) => {
    const ctx = audio.ctx;
    if (!ctx) return;
    let ts = Math.ceil(target / QUANTUM - 1e-6) * QUANTUM;
    if (ts <= ctx.currentTime + 1e-9) ts = ctx.currentTime + QUANTUM;
    if (ts * SR >= ctx.length - 128) { audio.error = 'audio timeline full'; return; }
    const reached = ctx.suspend(ts);
    if (!audio.started) {
      audio.started = true;
      audio.rendered = ctx.startRendering().catch((e) => { audio.error = String(e); return null; });
    } else await ctx.resume();
    await reached;
  };

  // steppable requestAnimationFrame: live (the browser's) until __cine.setManual(true)
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  let manual = false, vt = 0, nextId = 1e9, audioT = 0;
  let queue = [];
  window.requestAnimationFrame = (cb) => {
    if (!manual) return realRaf(cb);
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    if (id >= 1e9) queue = queue.filter((e) => e.id !== id);
    else realCancel(id);
  };
  window.__cine = {
    pad,
    audio,
    get manual() { return manual; },
    /** switch to the virtual clock (true) or back to the browser's (false) */
    async setManual(on) {
      if (on === manual) return;
      if (on) {
        manual = true;
        // let one pending browser frame land in the queue, then continue from the browser's clock
        await new Promise((r) => setTimeout(r, 100));
        vt = performance.now();
        audioT = audio.ctx ? audio.ctx.currentTime : 0;
      } else {
        manual = false;
        const q = queue; queue = [];
        for (const e of q) realRaf(e.cb);
      }
    },
    /** audio clock (s) at the start of the next frame */
    audioTime() { return audio.ctx ? audio.ctx.currentTime : -1; },
    /** advance the virtual clock by dtMs: run the queued frame callbacks once, then render dtMs of audio */
    async step(dtMs) {
      vt += dtMs;
      const q = queue; queue = [];
      for (const e of q) e.cb(vt);
      if (dtMs > 0) { // a zero step (settling the stream) renders a frame without moving any clock
        audioT += dtMs / 1000;
        await advanceAudio(audioT);
      }
      return q.length;
    },
    /** streaming work still pending (layouts, bakes, uploads, tiles fading in) */
    busy() {
      const st = window.__backrooms.stats();
      return st.chunks.layoutsPending + st.tiles.queued + st.tiles.inFlight + st.tiles.uploadsPending + st.tiles.fadingIn;
    },
    /** finish the offline render; returns the sample count */
    async finishAudio() {
      if (!audio.ctx || !audio.started) return 0;
      await audio.ctx.resume();
      const buf = await audio.rendered;
      audio.buffer = buf;
      return buf ? buf.length : 0;
    },
    /** base64 of interleaved float32 stereo samples [from, to) of the rendered buffer */
    audioChunk(from, to) {
      const b = audio.buffer;
      if (!b) return '';
      const n = Math.max(0, Math.min(b.length, to) - from);
      const l = b.getChannelData(0), r = b.getChannelData(1);
      const out = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { out[2 * i] = l[from + i]; out[2 * i + 1] = r[from + i]; }
      const u8 = new Uint8Array(out.buffer);
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return btoa(s);
    },
  };
}

function settingsFor(o) {
  return {
    version: 1, quality: o.quality, overrides: { dynamicResolution: false },
    fov: 62, headBob: 1, cameraShake: 0.5, walkSpeed: 'normal', flicker: 'standard',
    film: { grain: o.grain, chromaticAberration: 1, vignette: 1, distortion: 1, camcorder: false },
    volume: { master: 0.8, ambience: 0.8, hum: 0.8, sfx: 0.9, ui: 0.6 }, mainsHz: 60, lastSeed: o.seed,
  };
}

async function openGame(browser, root, o, { width, height }, extraParams = '', audioSeconds = 0) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript(pageInit, { hc: PAGE_HC, settings: settingsFor(o), audioSeconds });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack ?? e.message)));
  const params = `seed=${encodeURIComponent(o.seed)}&quality=${o.quality}&hud=0${audioSeconds > 0 ? '' : '&noaudio=1'}${extraParams ? '&' + extraParams : ''}&autostart=1`;
  await page.goto(`${root}?${params}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__backrooms?.ready === true, null, { timeout: 120000, polling: 200 });
  return { page, errors };
}

const idle = (page, ms = 30000) => withTimeout(page.evaluate((t) => window.__backrooms.waitForIdle(t), ms), ms + 5000, 'waitForIdle');
const player = (page) => page.evaluate(() => window.__backrooms.stats().player);

// ---------------------------------------------------------------- scout

async function scout(o) {
  const out = o.out ?? '/tmp/showcase-scout';
  mkdirSync(out, { recursive: true });
  const vite = await startVite();
  const browser = await launchBrowser();
  const report = [];
  try {
    await warmGpu(browser);
    const { page, errors } = await openGame(browser, vite.url, o, parseSize(o.size), o.extra);
    for (const t of o.targets) {
      const slug = t.replace(/[^a-z0-9]+/gi, '_');
      let ok = false;
      // 'pos:s:x:z:yawDeg' teleports to a raw position; anything else is a goto target
      const raw = /^pos:(\d):(-?[\d.]+):(-?[\d.]+):(-?[\d.]+)$/.exec(t);
      try {
        ok = raw
          ? (await withTimeout(page.evaluate((a) => window.__backrooms.teleport(a), { s: +raw[1], x: +raw[2], z: +raw[3], yaw: (+raw[4] * Math.PI) / 180, pitch: 0 }), 120000, 'teleport'), true)
          : await withTimeout(page.evaluate((q) => window.__backrooms.goto(q), t), 120000, 'goto');
      } catch (e) { console.error(t, e.message); }
      if (!ok) { report.push({ target: t, ok: false }); console.error(`[scout] ${t}: not found`); continue; }
      await idle(page, o.idle);
      const p = await player(page);
      const views = [];
      for (let k = 0; k < 4; k++) {
        const yaw = p.yaw + (k * Math.PI) / 2;
        await page.evaluate(([y, pi]) => window.__backrooms.look(y, pi), [yaw, k === 0 ? p.pitch : 0]);
        await page.waitForTimeout(400);
        const file = path.join(out, `${slug}-${k}.jpg`);
        await page.screenshot({ path: file, type: 'jpeg', quality: 85 });
        views.push(file);
      }
      const ascii = await page.evaluate(() => window.__backrooms.ascii(40));
      writeFileSync(path.join(out, `${slug}.txt`), `${t}\n${JSON.stringify(p)}\n${ascii}\n`);
      report.push({ target: t, ok: true, player: p, views });
      console.error(`[scout] ${t}: s=${p.s} x=${p.x} z=${p.z} yaw=${p.yaw} zone=${p.zone}`);
    }
    report.push({ errors });
    await page.close();
  } finally {
    await browser.close();
    stopVite(vite);
  }
  writeFileSync(path.join(out, 'scout.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.map((r) => ({ target: r.target, ok: r.ok, p: r.player && [r.player.s, r.player.x, r.player.z, r.player.yaw, r.player.zone] })), null, 1));
}

// ---------------------------------------------------------------- paths

const DEG = Math.PI / 180;
const WALK = 1.75; // m/s, PLAYER.walk (stick magnitude 1)
const DEADZONE = 0.15; // input.ts GAMEPAD.deadzone (radial, rescaled)

/** Cubic Hermite through time-stamped keys [[t, ...values]] with Catmull-Rom tangents; linear outside the range. */
function makeCurve(keys) {
  const k = keys.map((r) => ({ t: r[0], v: r.slice(1) }));
  const n = k.length, dim = k[0].v.length;
  const tan = k.map((_, i) => {
    if (n === 1) return new Array(dim).fill(0);
    const a = k[Math.max(0, i - 1)], b = k[Math.min(n - 1, i + 1)];
    return a.v.map((_, d) => (b.v[d] - a.v[d]) / (b.t - a.t));
  });
  const at = (t) => {
    if (n === 1) return { v: k[0].v.slice(), d: new Array(dim).fill(0) };
    if (t <= k[0].t) return { v: k[0].v.map((x, d) => x + tan[0][d] * (t - k[0].t)), d: tan[0].slice() };
    if (t >= k[n - 1].t) return { v: k[n - 1].v.map((x, d) => x + tan[n - 1][d] * (t - k[n - 1].t)), d: tan[n - 1].slice() };
    let i = 0;
    while (i < n - 2 && t > k[i + 1].t) i++;
    const a = k[i], b = k[i + 1], h = b.t - a.t, s = (t - a.t) / h;
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const d00 = (6 * s2 - 6 * s) / h, d10 = (3 * s2 - 4 * s + 1), d01 = (-6 * s2 + 6 * s) / h, d11 = (3 * s2 - 2 * s);
    return {
      v: a.v.map((_, d) => h00 * a.v[d] + h10 * h * tan[i][d] + h01 * b.v[d] + h11 * h * tan[i + 1][d]),
      d: a.v.map((_, d) => d00 * a.v[d] + d10 * tan[i][d] + d01 * b.v[d] + d11 * tan[i + 1][d]),
    };
  };
  return at;
}

/** Look keys in degrees -> radians, unwrapped so the camera always turns the short way between keys. */
function lookCurve(look) {
  let prev = null;
  const keys = look.map(([t, yawDeg, pitchDeg]) => {
    let y = yawDeg * DEG;
    if (prev !== null) { while (y - prev > Math.PI) y -= 2 * Math.PI; while (y - prev < -Math.PI) y += 2 * Math.PI; }
    prev = y;
    return [t, y, (pitchDeg ?? 0) * DEG];
  });
  return makeCurve(keys);
}

/** World velocity + position error -> left-stick axes for the player's yaw (inverse of input.ts deadzone mapping). */
function stickFor(vx, vz, yaw) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
  let mz = (vx * fx + vz * fz) / WALK, mx = (vx * rx + vz * rz) / WALK;
  let m = Math.hypot(mx, mz);
  if (m > 1) { mx /= m; mz /= m; m = 1; }
  if (m < 0.004) return [0, 0];
  const raw = DEADZONE + m * (1 - DEADZONE);
  return [(mx / m) * raw, (-mz / m) * raw];
}

// ---------------------------------------------------------------- overlay (camcorder title-generator caption)

/** Installs the caption element (the game's own .br-caption look, driven per frame instead of by CSS timers). */
function installOverlay() {
  if (document.getElementById('cine-ui')) return;
  const ui = document.createElement('div');
  ui.id = 'cine-ui';
  ui.className = 'br-ui';
  ui.style.zIndex = '50';
  ui.innerHTML = `<div class="br-caption" id="cine-cap" style="transition:none"><div class="br-caption-title" id="cine-t"></div><div class="br-caption-sub" id="cine-s"></div></div>
    <div id="cine-fade" style="position:absolute;inset:0;background:#000;opacity:0"></div>
    <div id="cine-card" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000;opacity:0">
      <div id="cine-card-t" style="font-size:clamp(28px,4.2vw,64px);letter-spacing:0.42em;margin-right:-0.42em;color:#ece6cd;text-shadow:0 0 12px rgba(236,230,205,0.25),1.5px 0 0 rgba(255,70,50,0.25),-1.5px 0 0 rgba(60,170,255,0.2)"></div>
      <div id="cine-card-s" style="white-space:pre-line;text-align:center;line-height:2.1;margin-top:1.6em;font-size:clamp(12px,1.1vw,17px);letter-spacing:0.3em;color:rgba(236,230,205,0.74)"></div>
    </div>`;
  document.body.appendChild(ui);
}

/** Per-frame overlay state: caption reveal (18-step typewriter like br-type), card and fade opacity. */
function applyOverlay(st) {
  const cap = document.getElementById('cine-cap');
  if (!cap) return;
  const t = document.getElementById('cine-t'), s = document.getElementById('cine-s');
  if (t.textContent !== st.title) t.textContent = st.title;
  if (s.textContent !== st.sub) s.textContent = st.sub;
  cap.style.opacity = String(st.capOpacity);
  const clip = (f) => `inset(0 ${Math.round((1 - Math.min(1, Math.max(0, f))) * 100)}% 0 0)`;
  t.style.clipPath = clip(st.revealT);
  s.style.clipPath = clip(st.revealS);
  document.getElementById('cine-card').style.opacity = String(st.cardOpacity);
  const ct = document.getElementById('cine-card-t'), cs = document.getElementById('cine-card-s');
  if (ct.textContent !== st.cardTitle) ct.textContent = st.cardTitle;
  if (cs.textContent !== st.cardSub) cs.textContent = st.cardSub;
  document.getElementById('cine-fade').style.opacity = String(st.fade);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (v) => { const x = clamp01(v); return x * x * (3 - 2 * x); };

/** Overlay values at shot time t (s). */
function overlayAt(shot, t) {
  const st = { title: '', sub: '', capOpacity: 0, revealT: 0, revealS: 0, cardTitle: '', cardSub: '', cardOpacity: 0, fade: 0 };
  // captions: the latest one that has started (`caption` is shorthand for a single one)
  const caps = shot.captions ?? (shot.caption ? [shot.caption] : []);
  const c = caps.filter((k) => (k.at ?? 1) <= t).pop() ?? caps[0];
  if (c) {
    const at = c.at ?? 1, hold = c.hold ?? 3.6;
    const u = t - at;
    st.title = c.title ?? ''; st.sub = c.sub ?? '';
    if (u >= 0 && u < hold + 0.7) {
      st.capOpacity = u < hold ? 1 : 1 - smooth((u - hold) / 0.7);
      const steps = (x) => Math.floor(clamp01(x / 0.9) * 18) / 18; // br-type: 0.9 s, steps(18)
      st.revealT = steps(u);
      st.revealS = steps(u - 0.35);
    }
  }
  const card = shot.card;
  if (card) {
    st.cardTitle = card.title ?? ''; st.cardSub = card.sub ?? '';
    const a = card.in ?? 0, b = card.out ?? shot.duration;
    const fi = card.fadeIn ?? 0.8, fo = card.fadeOut ?? 0.8;
    st.cardOpacity = t < a ? 0 : t < a + fi ? smooth((t - a) / fi) : t < b - fo ? 1 : t < b ? 1 - smooth((t - (b - fo)) / fo) : 0;
    if (card.from0) st.cardOpacity = t < b - fo ? 1 : t < b ? 1 - smooth((t - (b - fo)) / fo) : 0;
  }
  const fin = shot.fadeIn ?? 0, fout = shot.fadeOut ?? 0;
  let f = 0;
  if (shot.fadeOutAt) f = smooth((t - shot.fadeOutAt[0]) / (shot.fadeOutAt[1] - shot.fadeOutAt[0]));
  if (fin > 0 && t < fin) f = Math.max(f, 1 - smooth(t / fin));
  if (fout > 0 && t > shot.duration - fout) f = Math.max(f, smooth((t - (shot.duration - fout)) / fout));
  st.fade = f;
  return st;
}

// ---------------------------------------------------------------- render

function startEncoder(file, fps, { width, height }, preview) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', preview ? 'veryfast' : 'medium', '-crf', preview ? '20' : '9', '-pix_fmt', preview ? 'yuv420p' : 'yuv444p',
    '-s', `${width}x${height}`, file];
  const p = spawn(FFMPEG, args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));
  return {
    write: (buf) => new Promise((res) => { if (p.stdin.write(buf)) res(); else p.stdin.once('drain', res); }),
    end: async () => { p.stdin.end(); await done; },
  };
}

async function renderShot(page, cdp, shot, o, size, file) {
  const fps = o.fps;
  const pathAt = makeCurve(shot.path);
  const lookAt = lookCurve(shot.look ?? [[0, shot.yaw ?? 0, shot.pitch ?? 0]]);
  const preroll = shot.preroll ?? 1.2;
  const p0 = pathAt(-preroll).v, l0 = lookAt(-preroll).v;
  const s = shot.s ?? 0;

  // live clock: teleport, wait for the full bake of everything streamed around the start
  await page.evaluate(() => window.__cine.setManual(false));
  await page.evaluate(() => { const a = window.__cine.pad.axes; a[0] = 0; a[1] = 0; });
  await page.evaluate((f) => window.__backrooms.setFlashlight(f), !!shot.flashlight);
  await withTimeout(page.evaluate((t) => window.__backrooms.teleport(t), { s, x: p0[0], z: p0[1], yaw: l0[0], pitch: l0[1] }), 180000, 'teleport');
  await idle(page, 120000);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__cine.setManual(true));
  // simTime: the simulation clock at shot time 0 (flicker, spark bursts and 'light dies' rolls are pure functions of
  // it, so a shot can put them where it wants); set while paused, then released so it runs on
  if (shot.simTime !== undefined) {
    await page.evaluate((t) => { window.__backrooms.setTime(t); window.__backrooms.setTime(null); }, shot.simTime - preroll);
  }

  const enc = startEncoder(file, fps, size, o.preview);
  const total = Math.round(shot.duration * fps);
  const pre = Math.round(preroll * fps);
  const errs = [];
  let st = await player(page);
  let maxErr = 0, audioStart = -1, settleMs = 0;
  const t0 = Date.now();
  for (let f = -pre; f < total; f++) {
    const t = f / fps;
    const P = pathAt(t), L = lookAt(t);
    // feed-forward velocity + position feedback (the controller lags the stick by ~0.1 s)
    const kp = 3.0;
    const ex = P.v[0] - st.x, ez = P.v[1] - st.z;
    const err = Math.hypot(ex, ez);
    // free: the stick is released and the path is not followed (after a glitch warp the player is somewhere the
    // path cannot know); push: [[t0, t1, yawDeg]] the stick is held full forward along yawDeg (into a wall)
    const free = (shot.free ?? []).some(([a, b]) => t >= a && t < b);
    const push = (shot.push ?? []).find(([a, b]) => t >= a && t < b);
    if (f >= 0 && !free && !push) maxErr = Math.max(maxErr, err);
    const tNext = (f + 1) / fps;
    const Pn = pathAt(tNext);
    const vx = Pn.d[0] + kp * ex, vz = Pn.d[1] + kp * ez;
    const yaw = L.v[0], pitch = L.v[1];
    const axes = free ? [0, 0]
      : push ? stickFor(-Math.sin(push[2] * DEG) * WALK, -Math.cos(push[2] * DEG) * WALK, yaw)
      : stickFor(vx, vz, yaw);
    const ov = f >= 0 ? overlayAt(shot, t) : null;
    // once a second (and at the shot's settleAt times) hold the video clock while the stream catches up, so
    // every visible tile is fully baked (storey switches, long walks into new chunks)
    if (f % fps === 0 || (shot.settleAt ?? []).some((a) => Math.round(a * fps) === f)) {
      const w0 = Date.now();
      while (Date.now() - w0 < 120000 && (await page.evaluate(() => window.__cine.busy())) > 0) {
        await page.evaluate(() => window.__cine.step(0));
        await new Promise((res) => setTimeout(res, 25));
      }
      settleMs += Date.now() - w0;
    }
    const buttons = (shot.press ?? []).filter(([pt]) => Math.round(pt * fps) === f).map(([, b]) => b);
    const r = await page.evaluate(async ([ax, ay, yw, pt, dt, ovs, btn]) => {
      const pad = window.__cine.pad;
      pad.axes[0] = ax; pad.axes[1] = ay; pad.timestamp = performance.now();
      pad.buttons.forEach((b, i) => { const on = btn.includes(i); b.pressed = on; b.value = on ? 1 : 0; });
      window.__backrooms.look(yw, pt);
      if (ovs) window.__cineOverlay(ovs);
      const a = window.__cine.audioTime();
      await window.__cine.step(dt);
      return { p: window.__backrooms.stats().player, a };
    }, [axes[0], axes[1], yaw, pitch, 1000 / fps, ov, buttons]);
    st = r.p;
    if (f === 0) audioStart = r.a;
    if (f >= 0) {
      const shotRes = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 94, optimizeForSpeed: true });
      await enc.write(Buffer.from(shotRes.data, 'base64'));
      if (process.env.CINE_DEBUG && f % 10 === 0) console.error(JSON.stringify({ f, px: +P.v[0].toFixed(3), pz: +P.v[1].toFixed(3), x: st.x, z: st.z, y: st.y, ax: axes.map((a) => +a.toFixed(3)) }));
      if (f % fps === 0) process.stderr.write(`\r[render] ${shot.name}: ${f}/${total} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s, path error max ${maxErr.toFixed(2)} m   `);
    }
  }
  await enc.end();
  await page.evaluate(() => { const a = window.__cine.pad.axes; a[0] = 0; a[1] = 0; });
  await page.evaluate(() => window.__cine.setManual(false));
  process.stderr.write(`\n[render] ${shot.name}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s (settling ${(settleMs / 1000).toFixed(0)} s), max path error ${maxErr.toFixed(2)} m\n`);
  return { name: shot.name, file, frames: total, fps, maxErr, audioStart, end: { s: st.s, x: st.x, z: st.z, yawDeg: +(st.yaw * 180 / Math.PI).toFixed(1) }, errs };
}

/** The game schedules transients 30 ms after the frame's audio time (env.ts DISPLAY_LATENCY): shift them back. */
const AUDIO_SYNC_S = 0.03;

/** 32-bit float WAV from interleaved float32 PCM. */
function wavFloat32(pcm, channels, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 4, 28); h.writeUInt16LE(channels * 4, 32); h.writeUInt16LE(32, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function render(o) {
  const script = JSON.parse(readFileSync(o.script, 'utf8'));
  if (script.seed && !o.seedSet) o.seed = String(script.seed);
  let shots = script.shots;
  if (o.only) shots = shots.filter((s) => o.only.includes(s.name));
  if (o.preview) { o.fps = 30; o.size = '960x540'; }
  const size = parseSize(o.size);
  const out = o.out ?? path.join('showcase', o.preview ? 'preview' : 'master');
  mkdirSync(path.join(out, 'shots'), { recursive: true });
  const vite = await startVite();
  const browser = await launchBrowser();
  const results = [];
  try {
    await warmGpu(browser);
    const audioSeconds = o.audio ? shots.reduce((a, sh) => a + (sh.preroll ?? 1.2) + sh.duration + 0.2, 0) * 1.05 + 5 : 0;
    const { page, errors } = await openGame(browser, vite.url, o, size, o.extra, audioSeconds);
    const info = await page.evaluate(() => {
      const st = window.__backrooms.stats();
      return { quality: st.quality, renderScale: st.renderScale, warnings: st.warnings, grain: JSON.parse(localStorage.getItem('backrooms.settings.v1')).film.grain };
    });
    console.error(`[render] quality ${info.quality}, render scale ${info.renderScale}, grain ${info.grain}${info.warnings.length ? ', warnings: ' + info.warnings.join('; ') : ''}`);
    await page.evaluate(`(${installOverlay.toString()})(); window.__cineOverlay = ${applyOverlay.toString()};`);
    const cdp = await page.context().newCDPSession(page);
    for (const shot of shots) {
      const file = path.join(out, 'shots', `${shot.name}.mkv`);
      results.push(await renderShot(page, cdp, shot, o, size, file));
    }
    if (audioSeconds > 0) {
      const n = await withTimeout(page.evaluate(() => window.__cine.finishAudio()), 600000, 'finishAudio');
      const aerr = await page.evaluate(() => window.__cine.audio.error);
      console.error(`[render] audio: ${n} samples rendered${aerr ? ', error: ' + aerr : ''}`);
      for (const r of results) {
        if (!(r.audioStart >= 0)) continue;
        const from = Math.round((r.audioStart + AUDIO_SYNC_S) * 48000);
        const len = Math.round((r.frames / r.fps) * 48000);
        const parts = [];
        for (let i = 0; i < len; i += 48000 * 5) {
          const b64 = await page.evaluate(([a, b]) => window.__cine.audioChunk(a, b), [from + i, from + Math.min(len, i + 48000 * 5)]);
          parts.push(Buffer.from(b64, 'base64'));
        }
        r.wav = r.file.replace(/\.mkv$/, '.wav');
        writeFileSync(r.wav, wavFloat32(Buffer.concat(parts), 2, 48000));
      }
    }
    results.push({ errors: errors.slice(0, 50) });
    await page.close();
  } finally {
    await browser.close();
    stopVite(vite);
  }
  writeFileSync(path.join(out, 'render-report.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}

// ---------------------------------------------------------------- assemble

function run(args) {
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}: ${args.join(' ')}`))));
  });
}

/** Integrated loudness (LUFS) of the shot WAVs played back to back. */
function loudnessOf(wavs) {
  return new Promise((res, rej) => {
    const args = ['-hide_banner', '-nostats'];
    for (const w of wavs) args.push('-i', w);
    args.push('-filter_complex', `${wavs.map((_, i) => `[${i}:a]`).join('')}concat=n=${wavs.length}:v=0:a=1,ebur128`, '-f', 'null', '-');
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', () => {
      const m = /Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(err);
      if (m) res(Number(m[1])); else rej(new Error('ebur128 measurement failed'));
    });
  });
}

/** Joins the rendered shots in script order: video concatenated as is (fades are in the frames), audio segments with
 * 15 ms edge fades (no clicks at the cuts), gain to the script's loudness target and a limiter; H.264 High / AAC in an MP4. */
async function assemble(o) {
  const script = JSON.parse(readFileSync(o.script, 'utf8'));
  const dir = o.out ?? path.join('showcase', 'master');
  const names = script.shots.map((s) => s.name);
  const list = path.join(dir, 'concat.txt');
  writeFileSync(list, names.map((n) => `file '${path.resolve(dir, 'shots', n + '.mkv')}'`).join('\n') + '\n');
  const wavs = names.map((n) => path.resolve(dir, 'shots', n + '.wav'));
  const haveAudio = wavs.every((w) => existsSync(w));
  const out = path.join(dir, o.output ?? script.output ?? 'showcase.mp4');
  const args = ['-f', 'concat', '-safe', '0', '-i', list];
  if (haveAudio) {
    for (const w of wavs) args.push('-i', w);
    const segs = wavs.map((_, i) => {
      const d = script.shots[i].duration;
      return `[${i + 1}:a]aresample=48000,afade=t=in:d=0.015,afade=t=out:st=${(d - 0.015).toFixed(3)}:d=0.015[a${i}]`;
    });
    const endFade = script.audioFadeOut ?? 2.5;
    const gainDb = (script.loudness ?? -18) - (await loudnessOf(wavs));
    const total = script.shots.reduce((a, s) => a + s.duration, 0);
    const graph = `${segs.join(';')};${wavs.map((_, i) => `[a${i}]`).join('')}concat=n=${wavs.length}:v=0:a=1,` +
      `afade=t=in:d=${script.audioFadeIn ?? 1.5},afade=t=out:st=${(total - endFade).toFixed(3)}:d=${endFade},` +
      `volume=${gainDb.toFixed(2)}dB,alimiter=limit=0.63:level=false[aout]`; // -4 dBFS: the AAC encoder overshoots sharp transients
    args.push('-filter_complex', graph, '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '320k', '-ar', '48000');
  } else args.push('-map', '0:v');
  args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', String(o.crf ?? script.crf ?? 17), '-tune', 'grain', '-profile:v', 'high',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
  console.error(`[assemble] ${names.length} shots -> ${out}${haveAudio ? '' : ' (no audio)'}`);
  await run(args);
  console.log(out);
}

// ---------------------------------------------------------------- main

const o = parseArgs(process.argv.slice(2));
if (o.cmd === 'scout') await scout(o);
else if (o.cmd === 'render') await render(o);
else if (o.cmd === 'assemble') await assemble(o);
else {
  console.error('usage: node tools/showcase.mjs scout|render ...');
  process.exitCode = 2;
}
