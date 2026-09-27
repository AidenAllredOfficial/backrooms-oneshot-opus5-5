// src/core/settings.ts — persisted user settings (localStorage 'backrooms.settings.v1'; store/validation in WP14).

import type { QualityConfig, QualityName } from './quality.ts';

export type FlickerMode = 'standard' | 'reduced' | 'off';
/** R2 (B7): comfort walk pace (player/controller.ts WALK_SPEEDS: 1.45 / 1.75 / 2.0 m/s). */
export type WalkSpeed = 'slow' | 'normal' | 'brisk';
// standard: <= 3 area-light transitions/s with depth > 20% (WCAG 2.3.1 general flash); lens may strobe faster.
// reduced: depth <= 40%, <= 2 Hz, no lens strobe. off: steady at the state's mean.

export interface Settings {
  version: 1;
  quality: QualityName | 'auto';
  overrides: Partial<QualityConfig>;
  fov: number; // vertical degrees, 50..90
  mouseSensitivity: number; // rad per pixel (count)
  invertY: boolean;
  headBob: number; // 0..1
  /** R2 (B7): handheld camera sway 0..1 (0.5 ~ 0.15 deg), independent of the camcorder OSD; 0 under frozen time */
  cameraShake: number;
  /** R2 (B7): walk pace in play (the attract walk and autowalk keep the default pace) */
  walkSpeed: WalkSpeed;
  flicker: FlickerMode;
  toggleSprint: boolean;
  toggleCrouch: boolean;
  brightnessEV: number; // -1..+1 exposure bias
  volume: { master: number; ambience: number; hum: number; sfx: number; ui: number };
  /** motionBlur: package C.4 camera motion blur (x the camcorder shutter; 0 = off, the motion-sickness opt-out);
   * flare: C.5 aperture star + lens ghosts on overexposed sources (0 = off) */
  film: { grain: number; chromaticAberration: number; vignette: number; distortion: number; camcorder: boolean; motionBlur: number; flare: number };
  mainsHz: 50 | 60;
  lastSeed: string;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  quality: 'auto',
  overrides: {},
  fov: 62,
  mouseSensitivity: 0.0014, // R2 (B7): was 0.0022 (~9 cm/360 at 800 dpi, twitchy); now ~14 cm/360
  invertY: false,
  headBob: 1,
  cameraShake: 0.5,
  walkSpeed: 'normal',
  flicker: 'standard',
  toggleSprint: false,
  toggleCrouch: false,
  brightnessEV: 0,
  volume: { master: 0.8, ambience: 0.8, hum: 0.8, sfx: 0.9, ui: 0.6 },
  film: { grain: 1, chromaticAberration: 1, vignette: 1, distortion: 1, camcorder: false, motionBlur: 1, flare: 1 },
  mainsHz: 60,
  lastSeed: '',
};
