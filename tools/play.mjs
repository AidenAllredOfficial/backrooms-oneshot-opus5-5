#!/usr/bin/env node
// Play launcher: builds the game, serves the production bundle and opens it in its own Chromium window.
//
//   npm run play                 build + serve dist/ on http://127.0.0.1:4173/ + open a Chromium app window
//   npm run play -- --no-build   reuse the existing dist/
//   npm run play -- --no-open    only build and serve (open the printed URL yourself)
//   npm run play -- --dev        serve the Vite dev server instead of the production bundle (hot reload, slower boot)
//
// Why a launcher (Linux, hybrid-GPU laptops): Chromium ignores WebGL's powerPreference there and renders on the GPU
// its ANGLE backend's EGL picks, which on this machine is the 2-CU Radeon 610M instead of the RTX 5070 Ti (13 fps vs
// 160 fps at high). With the NVIDIA driver the launcher uses PRIME render offload (__NV_PRIME_RENDER_OFFLOAD=1 +
// NVIDIA's EGL/GLX vendor) with the default OpenGL backend: measured at 165 Hz it paces better than ANGLE's Vulkan
// backend (p95 6.8 ms vs 12.2 ms at the same ~2 ms GPU time). Mesa discrete GPUs get DRI_PRIME=1; anything else falls
// back to --use-angle=vulkan (which picks a discrete GPU). Environment and flags only apply when the browser process
// starts, so the window uses its own profile (~/.cache/backrooms-chromium): it starts fresh even when your normal
// Chromium is open, and your normal profile is never touched. The production bundle also boots ~1.3 s faster than
// the dev server (no unbundled module loading).
// Wayland sessions: Chromium's native Wayland backend falls back to SOFTWARE compositing on this machine (every
// backend and GPU; chrome://gpu "Compositing: Software only"): each frame the WebGL canvas is read back from the GPU
// (a ~6 ms stall that serialises CPU and GPU) and composited on the CPU. Measured at ultra, 165 Hz: 94 fps idle and
// 79 fps walking, and every render-scale change stalled 100-160 ms. Under XWayland (--ozone-platform=x11) compositing
// is hardware accelerated: 149 fps idle, 128 fps walking, a render-scale change costs <= 18 ms. The launcher therefore
// runs the window through XWayland when it is available (BACKROOMS_OZONE=wayland keeps the native backend), and
// tells the page to skip its first-context-loss wait (noprime=1; that loss is the Wayland GPU-process restart).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const dev = args.has('--dev');
const PORT = dev ? 5173 : 4173;
const URL = `http://127.0.0.1:${PORT}/`;

const up = async () => { try { return (await fetch(URL)).ok; } catch { return false; } };

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  for (const c of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge']) {
    if (spawnSync('which', [c], { stdio: 'ignore' }).status === 0) return c;
  }
  return null;
}

if (!dev && !args.has('--no-build')) {
  console.log('[play] building (vite build)...');
  const b = spawnSync('npx', ['vite', 'build'], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] });
  if (b.status !== 0) { console.error('[play] build failed'); process.exit(1); }
}

let server = null;
if (await up()) {
  console.log(`[play] a server is already running on ${URL}; using it`);
} else {
  const cmd = dev ? ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1']
    : ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'];
  server = spawn('npx', cmd, { cwd: REPO, stdio: 'ignore', detached: true });
  for (let i = 0; i < 100 && !(await up()); i++) await new Promise((r) => setTimeout(r, 150));
  if (!(await up())) { console.error(`[play] the server did not start on ${URL}`); process.exit(1); }
}
const stopServer = () => { if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch {} server = null; } };
process.on('SIGINT', () => { stopServer(); process.exit(130); });
process.on('SIGTERM', () => { stopServer(); process.exit(143); });

console.log(`[play] serving ${dev ? 'the dev server' : 'the production build'} at ${URL}`);
if (args.has('--no-open')) {
  console.log('[play] open the URL yourself; Ctrl+C stops the server');
  await new Promise(() => {});
}

const chromium = platform() === 'linux' ? findChromium() : null;
if (!chromium) {
  // macOS / Windows pick the discrete GPU from powerPreference: the default browser is fine
  const opener = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [URL], { stdio: 'ignore', shell: platform() === 'win32', detached: true }).unref();
  console.log('[play] opened in the default browser; Ctrl+C stops the server');
  await new Promise(() => {});
}

const profile = path.join(homedir(), '.cache', 'backrooms-chromium');
if (!existsSync(profile)) mkdirSync(profile, { recursive: true });

// GPU selection (see the header)
const NV_EGL = '/usr/share/glvnd/egl_vendor.d/10_nvidia.json';
const has = (cmd) => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
const env = { ...process.env };
const gpuFlags = [];
let gpuMode;
if (has('nvidia-smi') && existsSync(NV_EGL) && process.env.BACKROOMS_ANGLE !== 'vulkan') {
  Object.assign(env, { __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia', __EGL_VENDOR_LIBRARY_FILENAMES: NV_EGL, __VK_LAYER_NV_optimus: 'NVIDIA_only' });
  gpuFlags.push('--use-gl=angle', '--use-angle=gl');
  gpuMode = 'NVIDIA PRIME offload, ANGLE OpenGL';
} else if (process.env.BACKROOMS_ANGLE !== 'vulkan' && existsSync('/sys/class/drm/card1') && existsSync('/sys/class/drm/card2')) {
  env.DRI_PRIME = '1';
  gpuMode = 'DRI_PRIME=1 (Mesa discrete GPU)';
} else {
  gpuFlags.push('--use-angle=vulkan', '--enable-features=Vulkan');
  gpuMode = 'ANGLE Vulkan';
}
// see the header: native Wayland means software compositing
const xwayland = !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') && !!process.env.DISPLAY &&
  process.env.BACKROOMS_OZONE !== 'wayland';
if (xwayland) { gpuFlags.push('--ozone-platform=x11'); gpuMode += ', XWayland'; }
// the first-context loss the game waits for at boot is the Wayland backend's GPU-process restart: none under XWayland
const appUrl = xwayland ? `${URL}?noprime=1` : URL;
const flags = [
  `--user-data-dir=${profile}`, ...gpuFlags, '--ignore-gpu-blocklist',
  '--no-first-run', '--no-default-browser-check', '--start-maximized',
  `--app=${appUrl}`,
];
console.log(`[play] opening ${chromium} (${gpuMode}; profile ${profile})`);
const browser = spawn(chromium, flags, { stdio: 'ignore', env });
browser.on('exit', () => {
  console.log('[play] window closed; stopping the server');
  stopServer();
  process.exit(0);
});
