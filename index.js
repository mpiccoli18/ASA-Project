// Importing main libraries
import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';

// Defining socket
const socket = new DjsConnect();

var delivered = false;

var agent_position = [];


/**
 * Simple BDI agent to find the highest package on a map.
 * position: {x:number,y:number} or [x,y]
 * map: Array of packages OR { packages: [...] } where each package is
 *   { id, x, y, height }
 * Returns the selected package object or null if none found.
 */
export async function getPackage(map) {
  // normalize agent position from global
  const pos = Array.isArray(agent_position)
    ? { x: agent_position[0], y: agent_position[1] }
    : (agent_position && typeof agent_position === 'object')
      ? { x: agent_position.x ?? 0, y: agent_position.y ?? 0 }
      : { x: 0, y: 0 };

  // normalize packages
  const packages = Array.isArray(map) ? map : (map && map.packages) ? map.packages : [];
  if (!Array.isArray(packages) || packages.length === 0) return null;

  // beliefs
  const beliefs = { position: pos, packages };

  // desires: choose package with maximum height
  let maxH = -Infinity;
  for (const p of beliefs.packages) {
    const h = p.height ?? p.z ?? p.alt ?? 0;
    if (h > maxH) maxH = h;
  }

  // candidates with max height
  const candidates = beliefs.packages.filter(p => (p.height ?? p.z ?? p.alt ?? 0) === maxH);

  // intentions: if multiple, pick the closest
  const distSq = (a,b) => {
    const ax = (a.x ?? a[0] ?? 0);
    const ay = (a.y ?? a[1] ?? 0);
    const bx = (b.x ?? b[0] ?? 0);
    const by = (b.y ?? b[1] ?? 0);
    const dx = ax - bx;
    const dy = ay - by;
    return dx*dx + dy*dy;
  };

  let best = candidates[0];
  let bestDist = distSq(beliefs.position, best);
  for (let i = 1; i < candidates.length; i++) {
    const d = distSq(beliefs.position, candidates[i]);
    if (d < bestDist) { best = candidates[i]; bestDist = d; }
  }

  return best;
}

// Function that return true if delivered, false if not
export async function isDelivered(){
    return delivered;
}

// Function that set initial position for the agent
export async function setPosition(x, y){
    agent_position[0] = x;
    agent_position[1] = y;
}

// Function that returns the agent position
export async function getPosition(){
    return [agent_position[0], agent_position[1]];
}

// Function that return the next move available
export async function move(map){
  // normalize current position
  const pos = Array.isArray(agent_position)
    ? { x: agent_position[0], y: agent_position[1] }
    : (agent_position && typeof agent_position === 'object')
      ? { x: agent_position.x ?? 0, y: agent_position.y ?? 0 }
      : { x: 0, y: 0 };

  // find target package (highest)
  const target = await getPackage(map);
  if (!target) {
    // no package found -> stay
    return { direction: null, position: [pos.x, pos.y] };
  }

  const tx = target.x ?? target[0] ?? 0;
  const ty = target.y ?? target[1] ?? 0;

  // normalize obstacles (if any)
  const obstaclesRaw = (map && map.obstacles) ? map.obstacles : [];
  const obstacleSet = new Set();
  if (Array.isArray(obstaclesRaw)) {
    for (const o of obstaclesRaw) {
      const ox = o.x ?? o[0];
      const oy = o.y ?? o[1];
      if (ox !== undefined && oy !== undefined) obstacleSet.add(`${ox},${oy}`);
    }
  }

  const width = map?.width ?? map?.w ?? null;
  const height = map?.height ?? map?.h ?? null;

  const moves = [
    { name: 'UP', dx: 0, dy: -1 },
    { name: 'DOWN', dx: 0, dy: 1 },
    { name: 'LEFT', dx: -1, dy: 0 },
    { name: 'RIGHT', dx: 1, dy: 0 },
    { name: 'STAY', dx: 0, dy: 0 }
  ];

  let bestMove = null;
  let bestDist = Infinity;

  for (const m of moves) {
    const nx = pos.x + m.dx;
    const ny = pos.y + m.dy;

    // check bounds if provided
    if (width !== null && (nx < 0 || nx >= width)) continue;
    if (height !== null && (ny < 0 || ny >= height)) continue;

    // check obstacles
    if (obstacleSet.has(`${nx},${ny}`)) continue;

    const dist = (nx - tx) * (nx - tx) + (ny - ty) * (ny - ty);
    if (dist < bestDist) {
      bestDist = dist;
      bestMove = { name: m.name, x: nx, y: ny };
    }
  }

  if (!bestMove) {
    return { direction: null, position: [pos.x, pos.y] };
  }

  // update internal agent position
  agent_position[0] = bestMove.x;
  agent_position[1] = bestMove.y;

  return { direction: bestMove.name, position: [bestMove.x, bestMove.y] };
}





// default export for backwards compatibility
export default getPackage;

