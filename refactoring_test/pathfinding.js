const MOVES = [
    { dir: 'up',    dx: 0,  dy:  1 },
    { dir: 'down',  dx: 0,  dy: -1 },
    { dir: 'right', dx:  1, dy:  0 },
    { dir: 'left',  dx: -1, dy:  0 },
];

/**
 * A* pathfinding on the game grid.
 * Returns the first direction to take toward (targetX, targetY), or null if unreachable.
 *
 * @param {number} startX
 * @param {number} startY
 * @param {number} targetX
 * @param {number} targetY
 * @param {Set<string>} knownWalls  - set of "x,y" keys treated as blocked
 * @param {number} mapMaxX
 * @param {number} mapMaxY
 * @returns {string|null}
 */
export function aStar(startX, startY, targetX, targetY, knownWalls, mapMaxX, mapMaxY) {
    const heuristic = (x, y) => Math.abs(targetX - x) + Math.abs(targetY - y);
    const openSet = [{ x: startX, y: startY, g: 0, f: heuristic(startX, startY), path: [] }];
    const closedSet = new Set();
    // Add a small buffer beyond the known map to allow navigation near edges
    const maxX = mapMaxX > 0 ? mapMaxX + 2 : 50;
    const maxY = mapMaxY > 0 ? mapMaxY + 2 : 50;

    while (openSet.length > 0) {
        openSet.sort((a, b) => a.f - b.f);
        const current = openSet.shift();

        if (current.x === targetX && current.y === targetY) {
            return current.path.length > 0 ? current.path[0] : null;
        }

        const currentKey = `${current.x},${current.y}`;
        if (closedSet.has(currentKey)) continue;
        closedSet.add(currentKey);

        for (const move of MOVES) {
            const nextX = current.x + move.dx;
            const nextY = current.y + move.dy;
            const nextKey = `${nextX},${nextY}`;

            if (nextX < -2 || nextY < -2 || nextX > maxX || nextY > maxY) continue;
            if (closedSet.has(nextKey)) continue;
            if (knownWalls.has(nextKey)) continue;

            const gScore = current.g + 1;
            openSet.push({
                x: nextX,
                y: nextY,
                g: gScore,
                f: gScore + heuristic(nextX, nextY),
                path: [...current.path, move.dir],
            });
        }
    }
    return null;
}
