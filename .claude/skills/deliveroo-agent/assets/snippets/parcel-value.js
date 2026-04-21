// Expected-value scoring for parcels. The headline question is always:
//   "If I commit to this parcel now, how much reward will I actually collect?"
// The answer depends on distance (to parcel, then to delivery) and reward decay.

import { manhattan } from './bfs-pathfind.js';

/**
 * Expected reward if we pick up this parcel and deliver to the nearest delivery tile.
 * Uses manhattan distance as a quick proxy; replace with BFS length if you want precision.
 *
 * @param {{x:number,y:number,reward:number}} parcel
 * @param {{x:number,y:number}} me
 * @param {Array<{x:number,y:number}>} deliveryTiles
 * @param {number} decayPerStep how much reward is lost per move (measure in-game; often ~1)
 * @returns {number} expected delivered reward; negative means not worth it
 */
export function parcelValue(parcel, me, deliveryTiles, decayPerStep = 1) {
  if (!deliveryTiles.length) return 0;

  const toParcel = manhattan(me, parcel);
  const nearestDelivery = deliveryTiles.reduce(
    (best, t) => {
      const d = manhattan(parcel, t);
      return d < best.d ? { t, d } : best;
    },
    { t: deliveryTiles[0], d: Infinity }
  );

  const totalSteps = toParcel + nearestDelivery.d;
  return parcel.reward - totalSteps * decayPerStep;
}

/**
 * Value of delivering *now* given a set of carried parcels.
 * Each carried parcel's value is its current reward minus the decay over the walk to delivery.
 *
 * @param {Array<{reward:number}>} carrying
 * @param {{x:number,y:number}} me
 * @param {Array<{x:number,y:number}>} deliveryTiles
 * @param {number} decayPerStep
 */
export function deliveryValue(carrying, me, deliveryTiles, decayPerStep = 1) {
  if (!carrying.length || !deliveryTiles.length) return 0;
  const dist = deliveryTiles.reduce(
    (best, t) => Math.min(best, manhattan(me, t)),
    Infinity
  );
  return carrying.reduce((sum, p) => sum + Math.max(0, p.reward - dist * decayPerStep), 0);
}
