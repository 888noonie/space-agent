---
name: Space Walk
description: Build structures in the 3D Space Walk world as a visible agent
metadata:
  placement: system
  when:
    tags:
      - space:open
  loaded:
    tags:
      - space:open
---

Use this skill when the Space Walk 3D widget is active in the current space.
The user can watch your agent character build structures in real-time.

availability
- `window.spaceWalk` exists when the Space Walk widget is rendered
- Check with `typeof window.spaceWalk !== "undefined"` before calling

world state
- `spaceWalk.state()` returns `{ agentPos, agentState, blocks, queueLength, blockTypes, bounds }`
- Block types: regolith, rock, basalt, titanium, glass, hull, light, copper, crystal, gold
- Coordinate bounds: x [-10,10], y [-3,12], z [-10,10]
- y=0 is the barren planet surface, build upward from y=1
- The agent character walks to each block and places it visually

main helpers
- spaceWalk.build(actions, maxBlocks?) queues build actions, returns `{ queued, pending, blocks }`
- spaceWalk.state() returns current world snapshot
- spaceWalk.clear(cx?, cz?, radius?) clears blocks above ground at center
- spaceWalk.reset() strips all non-terrain blocks back to barren surface
- spaceWalk.log(msg) shows a message in the activity log

action format
- actions is an array of `{ type, x, y, z, blockType? }`
- type: "place" to add a block, "break" to remove
- x, y, z: integer coordinates within bounds
- blockType: required for "place", one of the valid block types
- Max 60 actions per call, agent builds them sequentially

camera behavior
- Camera automatically swoops to close-up when the agent builds
- Camera pulls back to birds-eye overview when thinking
- The user can also take manual first-person control

rules
- Always check `spaceWalk.state()` first to see the current world
- Keep structures within bounds x,z [-10,10] and y [-3,12]
- Build from ground up: start at y=1 (surface is y=0)
- Use staged execution: check state on one turn, build on the next
- The agent character physically walks to each block before placing it
- Narrate what you are building so the user knows what to watch for

examples
Checking the Space Walk world state
_____javascript
return spaceWalk.state()

Building a small shelter on the surface
_____javascript
const actions = [];
const bx = 3, bz = 3;
for (let dx = 0; dx < 4; dx++)
  for (let dz = 0; dz < 4; dz++)
    for (let dy = 1; dy <= 3; dy++) {
      if (dy === 1) actions.push({ type: "place", x: bx+dx, y: dy, z: bz+dz, blockType: "titanium" });
      else if (dx === 0 || dx === 3 || dz === 0 || dz === 3) actions.push({ type: "place", x: bx+dx, y: dy, z: bz+dz, blockType: "hull" });
      else if (dy === 3) actions.push({ type: "place", x: bx+dx, y: dy, z: bz+dz, blockType: "glass" });
    }
actions.push({ type: "break", x: bx+1, y: 2, z: bz });
actions.push({ type: "break", x: bx+1, y: 3, z: bz });
return spaceWalk.build(actions)

Clearing the area around the agent
_____javascript
return spaceWalk.clear()

Logging a message to the activity feed
_____javascript
spaceWalk.log("Starting construction of the observation tower")
return "Logged"
