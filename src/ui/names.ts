// src/ui/names.ts (R2, B7) — display names for zones, storeys and landmarks: the camcorder captions, the pause
// location line and the tape log. Upper-case OSD text; the ids stay in core/ids.ts.

import { LANDMARK_NAMES, LandmarkKind, Storey, Zone, ZONE_NAMES } from '../core/ids.ts';

export const STOREY_TITLES: Readonly<Record<number, string>> = {
  [Storey.LOBBY]: 'Level 0',
  [Storey.SUBLEVEL]: 'Sublevel',
  [Storey.POOLROOMS]: 'The Poolrooms',
};

export const ZONE_TITLES: Readonly<Record<number, string>> = {
  [Zone.LOBBY]: 'The Lobby',
  [Zone.MANILA]: 'Manila Rooms',
  [Zone.DARK]: 'Lights Out',
  [Zone.MAZE]: 'Partition Maze',
  [Zone.LOW_EXPANSE]: 'Low Expanse',
  [Zone.PILLAR_HALL]: 'Pillar Halls',
  [Zone.OFFICE]: 'Vacant Offices',
  [Zone.POOLROOMS]: 'The Poolrooms',
  [Zone.PARKING]: 'Parking Structure',
  [Zone.PIPEWORKS]: 'Pipeworks',
  [Zone.WAREHOUSE]: 'Warehouse',
  [Zone.CONCRETE]: 'Service Corridors',
};

export const LANDMARK_TITLES: Readonly<Record<number, string>> = {
  [LandmarkKind.RED_ROOM]: 'The Red Room',
  [LandmarkKind.ENDLESS_HALL]: 'The Endless Hallway',
  [LandmarkKind.ATRIUM]: 'The Atrium',
  [LandmarkKind.CHAIR_CATHEDRAL]: 'Chair Cathedral',
  [LandmarkKind.FLOODED_HALL]: 'Flooded Hall',
  [LandmarkKind.LOCKED_EXIT]: 'Locked Exit',
  [LandmarkKind.VENDING_ALCOVE]: 'Vending Alcove',
  [LandmarkKind.SERVER_ROOM]: 'Server Room',
  [LandmarkKind.DEEP_END]: 'The Deep End',
  [LandmarkKind.SKYLIGHT_HALL]: 'Skylight Hall',
  [LandmarkKind.LOCKER_ROOM]: 'Locker Room',
  [LandmarkKind.LOADING_DOCK]: 'Loading Dock',
  [LandmarkKind.BOILER_HALL]: 'Boiler Hall',
  [LandmarkKind.STAIRS_TO_NOWHERE]: 'Stairs to Nowhere',
  [LandmarkKind.LIGHT_WELL]: 'Light Well',
  [LandmarkKind.SPLIT_LEVEL_HALL]: 'Split-Level Hall',
  [LandmarkKind.RESTROOM_BLOCK]: 'Restrooms',
  [LandmarkKind.CAFETERIA]: 'Cafeteria',
  [LandmarkKind.MOTEL_CORRIDOR]: 'Motel Corridor',
  [LandmarkKind.CHAPEL]: 'Chapel',
  [LandmarkKind.CHILDRENS_PLAYROOM]: 'Playroom',
  [LandmarkKind.DRAINED_POOL]: 'Drained Pool',
  [LandmarkKind.SLIDE_TOWER]: 'Slide Tower',
  [LandmarkKind.LAZY_RIVER]: 'Lazy River',
  [LandmarkKind.SHOWER_BLOCK]: 'Showers',
  [LandmarkKind.TALL_ROOM]: 'The Tall Room',
  [LandmarkKind.CHAIR_STACKS]: 'Chair Stacks',
  [LandmarkKind.CRT_WALL]: 'Wall of Screens',
  [LandmarkKind.STAIRCASE_TO_CEILING]: 'Staircase to the Ceiling',
  [LandmarkKind.CONVERSATION_PIT]: 'Conversation Pit',
  [LandmarkKind.EXECUTIVE_SUITE]: 'Executive Suite',
  [LandmarkKind.COPY_ROOM]: 'Copy Room',
  [LandmarkKind.HALF_LEVEL]: 'Half Level',
  [LandmarkKind.TOLL_BOOTH]: 'Toll Booth',
  [LandmarkKind.MEZZANINE_OFFICE]: 'Mezzanine Office',
  [LandmarkKind.CRANE_BAY]: 'Crane Bay',
  [LandmarkKind.VALVE_GALLERY]: 'Valve Gallery',
  [LandmarkKind.SUMP_PIT]: 'Sump Pit',
};

const titleCase = (id: string): string => id.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function storeyTitle(s: number): string { return STOREY_TITLES[s] ?? `Storey ${s}`; }
export function zoneTitle(z: number): string { return ZONE_TITLES[z] ?? titleCase(ZONE_NAMES[z] ?? `zone ${z}`); }
export function landmarkTitle(k: number): string { return LANDMARK_TITLES[k] ?? titleCase(LANDMARK_NAMES[k] ?? `landmark ${k}`); }

/**
 * Place name for a storey + zone: 'Level 0 — Manila Rooms', 'The Poolrooms' (the POOLROOMS zone names itself on
 * any storey), 'Sublevel — Pipeworks', 'The Poolrooms — Pillar Halls'. zone < 0: the storey alone.
 */
export function placeTitle(s: number, zone: number): string {
  if (zone === Zone.POOLROOMS) return ZONE_TITLES[Zone.POOLROOMS];
  if (zone < 0) return storeyTitle(s);
  return `${storeyTitle(s)} — ${zoneTitle(zone)}`;
}
