// BFS shortest path on the tile grid. Returns a list of 'up'/'down'/'left'/'right'
// directions from `start` to `goal`, or null if unreachable.
//
// Note on coordinate convention: up = y+1, down = y-1. This is math-style,
// not screen-style. If your pathfinding output looks mirrored, check here first.

/**
 * @param {{ width:number, height:number, tiles: Array<{x:number,y:number,type:string}> }} map
 * @param {{x:number,y:number}} start
 * @param {{x:number,y:number}} goal
 * @param {Set<string>} [blocked] set of 'x,y' strings for tiles occupied by other agents
 * @returns {string[]|null}
 */
export function bfsPath(map, start, goal, blocked = new Set()) {
  const walkable = buildWalkable(map, blocked);
  const key = (x, y) => `${x},${y}`;
  const goalKey = key(goal.x, goal.y);

  // if goal is the start, no moves needed
  if (key(start.x, start.y) === goalKey) return [];

  const queue = [{ x: start.x, y: start.y, path: [] }];
  const seen = new Set([key(start.x, start.y)]);

  while (queue.length) {
    const { x, y, path } = queue.shift();
    for (const { dir, nx, ny } of neighbors(x, y)) {
      const nk = key(nx, ny);
      if (seen.has(nk)) continue;
      if (!walkable.has(nk) && nk !== goalKey) continue; // allow final step onto goal even if occupied
      seen.add(nk);
      const nextPath = [...path, dir];
      if (nk === goalKey) return nextPath;
      queue.push({ x: nx, y: ny, path: nextPath });
    }
  }
  return null;
}

function buildWalkable(map, blocked) {
  const set = new Set();
  for (const t of map.tiles) {
    // tile types: '0' non-walkable, '1' spawner, '2' delivery, '3' walkable, '4' base
    // spawners, deliveries, walkables, and bases are all walkable
    if (t.type !== '0') {
      const k = `${t.x},${t.y}`;
      if (!blocked.has(k)) set.add(k);
    }
  }
  return set;
}

function* neighbors(x, y) {
  yield { dir: 'right', nx: x + 1, ny: y };
  yield { dir: 'left',  nx: x - 1, ny: y };
  yield { dir: 'up',    nx: x,     ny: y + 1 };
  yield { dir: 'down',  nx: x,     ny: y - 1 };
}

/**
 * Manhattan distance — cheap heuristic, useful for option scoring.
 */
export function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
