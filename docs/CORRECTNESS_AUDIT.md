**Correctness and bug audit, October 1, 2026**

The audit covered application lifecycle, player input and traversal, world generation and streaming, worker protocols and caching, rendering and capture, audio playback, persistence, and capture tooling. Three subagents audited runtime, rendering, and streaming in parallel; the main agent audited audio and tooling, reviewed the combined changes, and exercised the production application in the browser. The fixes are in the working tree, with regression tests for the failures found.

| Area | Failures fixed |
| --- | --- |
| Loading readiness | Low-quality loading could wait 45 seconds for chunks outside its streaming radius. Readiness now respects the requested radius and edge-fog visibility. Two regressions reproduce seed 7's actual spawn at radius 0 and 1. |
| Worker initialization | Unexpected initialization responses, worker crashes, factory failures, and failed message sends could strand initialization or jobs. These paths now reject and retire failed workers. Response types are checked against requests. |
| World coordinates | Packed chunk keys collided at coordinates 32,768 chunks apart. Nearby chunks retain compact numeric keys; distant chunks use full-coordinate keys. |
| World queries | Huge sparse queries could iterate excessive empty space. They now scan resident chunks when appropriate. Box-query deduplication stamps are shared by storey so different consumers cannot suppress each other's results. |
| Streamer disposal | Pending queries could accept late responses after streamer disposal. Disposal cancels their handles and ignores late callbacks. |
| Startup job reuse | Preview lighting jobs could be reused for requests requiring full lighting. Cache keys now distinguish the two; full results can still fulfill preview requests. |
| Tile cache | Malformed metadata, inherited constructor names, misaligned typed arrays, and ranges outside a supplied byte view could be accepted. Cache decoding validates these boundaries and number markers. Special property names such as `__proto__` could disappear or alter decoded object prototypes; encoding, decoding, and canonical key generation now preserve them safely. Writer failures clear pending work and release the failed worker. |
| Geometry allocation | A zero-capacity geometry writer could fail to grow. It now starts with a usable minimum capacity and rejects invalid capacity values. |
| Spawn generation | The clear test scene could not satisfy a clear-scene spawn query. The generator now recognizes that request. |
| Keyboard and pointer input | Browser shortcuts could trigger game actions, SELECT controls could lose keyboard handling, and queued movement or actions could survive blur or pointer unlock. Input filtering and reset now cover these paths. |
| Gamepad input | Reconnection and input resets could retain stale pad state. Reconnection resets button and axis state. |
| Autostart parsing | Input initialization interpreted boolean aliases differently from URL parsing. Both now apply the same interpretation. |
| Saved locations | Shared links and Continue could lose player height. Links could also discard forced world settings. Height and active world overrides now survive serialization, loading, and context recovery. |
| URL validation | Very large finite yaw values could overflow during degree conversion, and conflicting pitch parameters lacked the intended warning. Conversion and precedence handling are corrected. |
| Seed persistence | Special seeds such as `__proto__` could interact with inherited object properties. Tape storage uses objects without prototypes. Blocked storage access is handled without aborting application initialization. |
| Application transitions | Overlapping tape changes could race with location loading; automated movement could survive title changes, loading, or context loss. Transitions are guarded and automation is cancelled. The HUD date updates when the seed changes. |
| Automated movement | Walk state could leak between app instances, cancelled walks could remain unresolved, and paused/loading time could consume automation deadlines. State is per app, cancellation settles the operation, and paused/loading time is excluded. |
| Pause and fade handling | Automation could drive a paused frame, and replacing a fade could strand its promise. The loop respects pause state and replaced fades settle. |
| Fly mode | Enabling flight could leave tower, elevator, warp, or glitch traversal active. Switching to flight cancels those transitions. |
| Performance statistics | Invalid history sizes and windows could corrupt statistics. High frame rates could exceed the fixed recording buffer and truncate samples. Inputs are normalized and recordings grow as needed. |
| Audio startup and buffers | Failed startup could prevent retry; disposal could strand buffer requests; failed worker sends or deserialization could halt work. Startup is retryable, disposal rejects outstanding requests, and worker failure falls back to inline synthesis while preserving priority. A rejected request cannot delete the deduplication entry for its immediate retry. |
| Audio resource cleanup | Future source-stop callbacks could lose cleanup, flat one-shots could survive stop-all, and emitter gains could leak during pending retunes. Source callbacks preserve cleanup, stop-all covers scheduled sources, and pending gains are released. |
| Audio interactions | Nearest radio/phone interaction could select a farther voiced emitter while ignoring a closer resident emitter. Selection includes unvoiced residents. Emitter identity now includes storey to prevent state collisions. |
| Sound propagation | Phantom footsteps could cross a wall into another otherwise reachable cell. Each step now requires a walkable destination and an acoustically traversable edge. |
| Water ripples | Frame hitches could make the simulation accumulator negative. Stationary water masks could miss newly streamed chunks, and ripple state could carry across storeys. Timing, mask invalidation, and reset behavior are corrected. Renderer state is restored even when rendering fails. |
| Water visibility | GPU occlusion results issued before a reset could later mark water visible. Query generations reject results from an earlier state. |
| Anomaly lighting | Rewinding time or changing storeys could leave old overrides and sparks active. Those transitions clear stale state. |
| Flashlight bounce | Zero, parallel, or vertical direction inputs could collapse the bounce cone basis. A normalized fallback basis handles degenerate inputs. |
| Reflections and portals | Parented cameras could use stale world transforms for planar reflections and portal views. These paths update world transforms before deriving the view. |
| Image capture | Capture failures could leave render targets, cube faces, or mip levels changed. Cleanup now runs on failure. Asynchronous capture rejects synchronous render errors, invalid dimensions, and disposed resources; disposal is idempotent. |
| Capture cache keys | Comma-joined repeated URL values and ambiguous parameter delimiters could collide or lose precedence. Keys retain ordered duplicate values and use unambiguous key/value serialization. |
| PNG tooling | Truncated chunks, missing image data, invalid dimensions or filters, and short encoder pixel buffers could produce misleading captures. Decoding and encoding validate these conditions. |

Verification completed after all fixes:

- `npm test`: **1,831 passed, 5 skipped**, across **166 passing test files and 1 skipped file**. This is **82 additional passing regression cases** over the initial baseline of 1,749. The full correctness sweeps ran. The five skipped cases are existing opt-in timing gates: four require `BENCH=1`, and one requires `GEN_PERF=1`.
- `npm run build`: passed, including `tsc --noEmit` and the Vite production build.
- `git diff --check`: passed.
- Production-browser checks exercised title/entry/pause, invalid and valid location links, seed/storey changes, low and high quality, GPU image readback, `__proto__` persistence, and Web Audio startup. The final low-quality seed-7 boot reached readiness without the 45-second warning. Audio reached `running` with five active voices. Checked flows reported no runtime errors.

The production build still emits its existing bundle-size advisory: the main minified chunk is approximately 2.17 MB, above the configured 2 MB threshold. This does not fail the build. Optional performance timing gates were not enabled.
