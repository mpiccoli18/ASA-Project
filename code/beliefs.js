/** @returns {import('./BDIAgent.js').Beliefs} */
export function createBeliefs() {
    return {
        me: { id: null, name: '', x: undefined, y: undefined, score: 0, penalty: 0 },
        deliveryZones: new Set(),
        parcels: new Map(),
        carrying: new Map(),
        visitedTiles: new Map(),
        mapWalls: new Set(),
        knownWalls: new Set(),
        unreachable: new Set(),
        collisionCounts: new Map(),
        mapMaxX: 0,
        mapMaxY: 0,
    };
}

/**
 * Ingests raw tile data from the server and updates map boundaries,
 * delivery zones, and permanent walls in-place.
 *
 * @param {import('./BDIAgent.js').Beliefs} beliefs
 * @param {object[]} tiles
 */
export function updateMapBeliefs(beliefs, tiles) {
    if (!Array.isArray(tiles)) return;

    let newZonesFound = 0;

    for (const tile of tiles) {
        if (tile.x > beliefs.mapMaxX) beliefs.mapMaxX = tile.x;
        if (tile.y > beliefs.mapMaxY) beliefs.mapMaxY = tile.y;

        const posKey = `${tile.x},${tile.y}`;

        if (tile.type === 2 || tile.type === '2' || tile.delivery || tile.deliveryZone || tile.type === 'delivery') {
            if (!beliefs.deliveryZones.has(posKey)) {
                beliefs.deliveryZones.add(posKey);
                newZonesFound++;
            }
        }

        if (tile.type === 0 || tile.type === '0' || tile.wall || tile.type === 'wall') {
            beliefs.mapWalls.add(posKey);
            beliefs.knownWalls.add(posKey);
        }
    }

    if (newZonesFound > 0) {
        console.log(`🗺️ EXPLORATION DISCOVERY: Memorized ${newZonesFound} new delivery zone(s)! (Total known: ${beliefs.deliveryZones.size})`);
    }
}

/**
 * Replaces the ground-parcel snapshot and updates carried-parcel state in-place.
 * Does NOT clear `carrying` — that's managed by safeInteract.
 *
 * @param {import('./BDIAgent.js').Beliefs} beliefs
 * @param {object[]|Map|object} parcelsData
 */
export function updateParcelBeliefs(beliefs, parcelsData) {
    beliefs.parcels.clear();

    if (!parcelsData) return;

    let parcelsList;
    if (Array.isArray(parcelsData)) {
        parcelsList = parcelsData;
    } else if (parcelsData instanceof Map) {
        parcelsList = Array.from(parcelsData.values());
    } else if (typeof parcelsData === 'object') {
        parcelsList = Object.values(parcelsData);
    } else {
        return;
    }

    for (const p of parcelsList) {
        if (!p || typeof p !== 'object') continue;

        const parcel = p.parcel ? { ...p.parcel, x: p.x, y: p.y } : p;
        if (!parcel.id) continue;

        parcel.reward = Number(parcel.reward) || 1;

        if (parcel.carriedBy === beliefs.me.id) {
            beliefs.carrying.set(parcel.id, parcel);
        } else if (!parcel.carriedBy || parcel.carriedBy === 'none') {
            beliefs.parcels.set(parcel.id, parcel);
        }
    }
}
