// src/world/heroRooms/index.ts — hero-room tier (R2 B4). A hero room is a LandmarkGenerator with `heroOnly` and a
// `hero` zone list: sites.ts gives every district one, picked (by weight) among the kinds whose `hero` list holds the
// district's zone and whose `storeys` hold the storey, stamped in the free chunk nearest the district site. Some regular
// landmarks double as heroes (DRAINED_POOL, SLIDE_TOWER, LAZY_RIVER, SHOWER_BLOCK: `hero` without `heroOnly`).
//
// Zone lists: LOBBY TALL_ROOM, CHAIR_STACKS, CRT_WALL, STAIRCASE_TO_CEILING, CONVERSATION_PIT; MANILA TALL_ROOM,
// CHAIR_STACKS, STAIRCASE_TO_CEILING, COPY_ROOM (+ SHOWER_BLOCK on storey 2); DARK / MAZE CHAIR_STACKS, CRT_WALL,
// STAIRCASE_TO_CEILING; OFFICE EXECUTIVE_SUITE, COPY_ROOM, CONVERSATION_PIT, CRT_WALL, CHAIR_STACKS; LOW_EXPANSE
// CONVERSATION_PIT, CRT_WALL (storey 2: LAZY_RIVER, SHOWER_BLOCK); PILLAR_HALL TALL_ROOM, CONVERSATION_PIT (storey 2:
// SLIDE_TOWER, LAZY_RIVER); PARKING HALF_LEVEL, TOLL_BOOTH, CRANE_BAY; WAREHOUSE MEZZANINE_OFFICE, CRANE_BAY;
// PIPEWORKS / CONCRETE VALVE_GALLERY, SUMP_PIT (CONCRETE storey 2: + SHOWER_BLOCK); POOLROOMS DRAINED_POOL, SLIDE_TOWER,
// LAZY_RIVER.

export { chairStacks } from './chairStacks.ts';
export { conversationPit } from './conversationPit.ts';
export { copyRoom } from './copyRoom.ts';
export { craneBay } from './craneBay.ts';
export { crtWall } from './crtWall.ts';
export { executiveSuite } from './executiveSuite.ts';
export { halfLevel } from './halfLevel.ts';
export { mezzanineOffice } from './mezzanineOffice.ts';
export { staircaseToCeiling } from './staircaseToCeiling.ts';
export { sumpPit } from './sumpPit.ts';
export { tallRoom } from './tallRoom.ts';
export { tollBooth } from './tollBooth.ts';
export { valveGallery } from './valveGallery.ts';
