// src/world/landmarks/index.ts — landmark generator registry (WP4). Index = LandmarkKind.
//
// Every generator claims a rotated W x L frame (common.ts) >= 2 cells from the seam lines (ENDLESS_HALL instead
// restyles the artery lane across the whole chunk), avoiding reserved cells with a 1-cell apron; its cells become
// LANDMARK|RESERVED so zone generators leave them alone. `stamp` returns the walkable cells just inside the openings
// (WP1 connectivity-repair targets).
//
// R2 (B4): 12 new lottery kinds (STAIRS_TO_NOWHERE .. SHOWER_BLOCK) and 13 hero-only kinds (world/heroRooms), and
// cross-storey restyles (VENDING_ALCOVE / LOCKED_EXIT on all storeys, RED_ROOM on 0-1, SERVER_ROOM on 0 as an IT
// closet). `hero` lists feed the one-per-district hero tier (sites.ts).

import type { ChunkGrid, LandmarkKindId, LandmarkSite, StoreyId, ZoneGenContext, ZoneId } from '../../core/index.ts';
import {
  chairStacks, conversationPit, copyRoom, craneBay, crtWall, executiveSuite, halfLevel, mezzanineOffice, staircaseToCeiling, sumpPit,
  tallRoom, tollBooth, valveGallery,
} from '../heroRooms/index.ts';
import { cafeteria } from './cafeteria.ts';
import { chapel } from './chapel.ts';
import { childrensPlayroom } from './childrensPlayroom.ts';
import { drainedPool } from './drainedPool.ts';
import { lazyRiver } from './lazyRiver.ts';
import { lightWell } from './lightWell.ts';
import { motelCorridor } from './motelCorridor.ts';
import { restroomBlock } from './restroomBlock.ts';
import { showerBlock } from './showerBlock.ts';
import { slideTower } from './slideTower.ts';
import { splitLevelHall } from './splitLevelHall.ts';
import { stairsToNowhere } from './stairsToNowhere.ts';
import { atrium } from './atrium.ts';
import { boilerHall } from './boilerHall.ts';
import { chairCathedral } from './chairCathedral.ts';
import { deepEnd } from './deepEnd.ts';
import { endlessHall } from './endlessHall.ts';
import { floodedHall } from './floodedHall.ts';
import { loadingDock } from './loadingDock.ts';
import { lockedExit } from './lockedExit.ts';
import { lockerRoom } from './lockerRoom.ts';
import { redRoom } from './redRoom.ts';
import { serverRoom } from './serverRoom.ts';
import { skylightHall } from './skylightHall.ts';
import { vendingAlcove } from './vendingAlcove.ts';

export interface LandmarkGenerator {
  kind: LandmarkKindId; storeys: readonly StoreyId[]; weight: number; footprint: [number, number]; // cells
  /** Hero-room tier: districts of these zones may pick this kind as their hero room (storey must be in `storeys`). */
  hero?: readonly ZoneId[];
  /** Never drawn by the regular landmark lottery (hero rooms only). */
  heroOnly?: boolean;
  /** entrances = walkable local cells just inside the landmark's openings (WP1 connectivity repair targets) */
  stamp(g: ChunkGrid, ctx: ZoneGenContext, site: LandmarkSite): { entrances: [number, number][] };
}

export const LANDMARKS: readonly LandmarkGenerator[] = [
  redRoom, // RED_ROOM
  endlessHall, // ENDLESS_HALL
  atrium, // ATRIUM
  chairCathedral, // CHAIR_CATHEDRAL
  floodedHall, // FLOODED_HALL
  lockedExit, // LOCKED_EXIT
  vendingAlcove, // VENDING_ALCOVE
  serverRoom, // SERVER_ROOM
  deepEnd, // DEEP_END
  skylightHall, // SKYLIGHT_HALL
  lockerRoom, // LOCKER_ROOM
  loadingDock, // LOADING_DOCK
  boilerHall, // BOILER_HALL
  stairsToNowhere, // STAIRS_TO_NOWHERE
  lightWell, // LIGHT_WELL
  splitLevelHall, // SPLIT_LEVEL_HALL
  restroomBlock, // RESTROOM_BLOCK
  cafeteria, // CAFETERIA
  motelCorridor, // MOTEL_CORRIDOR
  chapel, // CHAPEL
  childrensPlayroom, // CHILDRENS_PLAYROOM
  drainedPool, // DRAINED_POOL
  slideTower, // SLIDE_TOWER
  lazyRiver, // LAZY_RIVER
  showerBlock, // SHOWER_BLOCK
  tallRoom, // TALL_ROOM
  chairStacks, // CHAIR_STACKS
  crtWall, // CRT_WALL
  staircaseToCeiling, // STAIRCASE_TO_CEILING
  conversationPit, // CONVERSATION_PIT
  executiveSuite, // EXECUTIVE_SUITE
  copyRoom, // COPY_ROOM
  halfLevel, // HALF_LEVEL
  tollBooth, // TOLL_BOOTH
  mezzanineOffice, // MEZZANINE_OFFICE
  craneBay, // CRANE_BAY
  valveGallery, // VALVE_GALLERY
  sumpPit, // SUMP_PIT
];

const heroLists = new Map<number, LandmarkKindId[]>();
/** Hero-room kinds a district of `zone` on storey `s` may pick (LANDMARKS order; cached). */
export function heroKindsFor(s: StoreyId, zone: ZoneId): readonly LandmarkKindId[] {
  const key = s * 64 + zone;
  let list = heroLists.get(key);
  if (!list) {
    list = LANDMARKS.filter((lg) => lg.hero?.includes(zone) && lg.storeys.includes(s)).map((lg) => lg.kind);
    heroLists.set(key, list);
  }
  return list;
}
