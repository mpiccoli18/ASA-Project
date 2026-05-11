import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import { createBeliefs, updateMapBeliefs, updateParcelBeliefs } from './beliefs.js';
import { aStar } from './pathfinding.js';
import {
    MAX_CARRY,
    COLLISION_THRESHOLD,
    OBSTACLE_FORGIVE_MS,
    INTERACT_TIMEOUT_MS,
    INTERACT_UNLOCK_DELAY_MS,
    MOVE_TIMEOUT_MS,
    UNREACHABLE_RECONSIDER_MS,
    BDI_LOOP_INTERVAL_MS,
    EXPLORE_RADIUS,
    EXPLORE_STEP,
    PROXIMITY_FORGIVE_DIST,
} from './constants.js';

/**
 * @typedef {Object} Beliefs
 * @property {{ id: string|null, name: string, x: number|undefined, y: number|undefined, score: number, penalty: number }} me
 * @property {Set<string>} deliveryZones
 * @property {Map<string, object>} parcels
 * @property {Map<string, object>} carrying
 * @property {Map<string, number>} visitedTiles
 * @property {Set<string>} mapWalls
 * @property {Set<string>} knownWalls
 * @property {Set<string>} unreachable
 * @property {Map<string, number>} collisionCounts
 * @property {number} mapMaxX
 * @property {number} mapMaxY
 */

export default class BDIAgent {
    constructor() {
        this.client = new DjsConnect(process.env.URL, process.env.TOKEN);
        this.beliefs = createBeliefs();
        this.exploreWay = null;
        this.deliveryWay = null;
        this.currentIntention = 'EXPLORE';
        this.isActing = false;
    }

    async start() {
        console.log("Starting BDI Agent...");

        this.client.on('map',     (tiles) => updateMapBeliefs(this.beliefs, tiles));
        this.client.on('tile',    (tile)  => updateMapBeliefs(this.beliefs, [tile]));
        this.client.on('you',     (me)    => { this.beliefs.me = me; });
        this.client.on('sensing', (data)  => {
            updateParcelBeliefs(this.beliefs, data.parcels ?? data);
        });

        process.on('SIGINT', () => {
            console.log("\nCTRL+C detected. Disconnecting agent...");
            if (this.client) this.client.disconnect();
            process.exit(0);
        });

        setInterval(() => this.bdiLoop(), BDI_LOOP_INTERVAL_MS);
    }

    // ─── DELIBERATION ────────────────────────────────────────────────────────────

    bdiLoop() {
        if (this.beliefs.me.x === undefined || this.beliefs.me.y === undefined) return;
        if (this.isActing) return;

        // Skip while the game engine is animating the move (coords go fractional mid-stride)
        const isMidStride =
            Math.abs(this.beliefs.me.x - Math.round(this.beliefs.me.x)) > 0.3 ||
            Math.abs(this.beliefs.me.y - Math.round(this.beliefs.me.y)) > 0.3;
        if (isMidStride) return;

        const myX = Math.round(this.beliefs.me.x);
        const myY = Math.round(this.beliefs.me.y);
        const posKey = `${myX},${myY}`;

        const visits = this.beliefs.visitedTiles.get(posKey) || 0;
        this.beliefs.visitedTiles.set(posKey, visits + 1);

        const isFull       = this.beliefs.carrying.size >= MAX_CARRY;
        const hasParcels   = this.beliefs.carrying.size > 0;
        const seesParcels  = this.beliefs.parcels.size > 0;
        const knowsDelivery = this.beliefs.deliveryZones.size > 0;

        if (isFull && knowsDelivery) {
            this.currentIntention = 'DELIVER_PARCEL';
        } else if (seesParcels && !isFull) {
            this.currentIntention = 'GET_PARCEL';
        } else if (hasParcels && knowsDelivery) {
            this.currentIntention = 'DELIVER_PARCEL';
        } else {
            this.currentIntention = 'EXPLORE';
        }

        // Reset stale waypoints when switching tasks
        if (this.currentIntention !== 'DELIVER_PARCEL') this.deliveryWay = null;
        if (this.currentIntention !== 'EXPLORE')        this.exploreWay  = null;

        this.isActing = true;
        let actionTaken = false;

        try {
            actionTaken = this.executeIntention(myX, myY);
        } catch (error) {
            console.error("Action failed:", error);
        }

        if (!actionTaken) this.isActing = false;
    }

    // ─── INTENTION EXECUTION ─────────────────────────────────────────────────────

    executeIntention(myX, myY) {
        switch (this.currentIntention) {
            case 'GET_PARCEL':     return this.executeGetParcel(myX, myY);
            case 'DELIVER_PARCEL': return this.executeDeliverParcel(myX, myY);
            case 'EXPLORE':        return this.executeExplore(myX, myY);
            default:               return false;
        }
    }

    executeGetParcel(myX, myY) {
        let bestParcel = null;
        let maxReward  = -Infinity;

        for (const parcel of this.beliefs.parcels.values()) {
            const px = Math.round(parcel.x);
            const py = Math.round(parcel.y);
            const key = `${px},${py}`;

            // Forgive parcels that appeared unreachable if we're now standing nearby
            if (Math.abs(myX - px) + Math.abs(myY - py) <= PROXIMITY_FORGIVE_DIST) {
                this.beliefs.unreachable.delete(key);
            }
            if (this.beliefs.unreachable.has(key)) continue;

            if (parcel.reward > maxReward) {
                maxReward  = parcel.reward;
                bestParcel = parcel;
            }
        }

        if (!bestParcel) {
            this.currentIntention = 'EXPLORE';
            return false;
        }

        const px = Math.round(bestParcel.x);
        const py = Math.round(bestParcel.y);

        console.log(`[GET_PARCEL] Me: (${myX}, ${myY}) | Target: (${px}, ${py})`);

        if (myX === px && myY === py) {
            console.log(`📦 STANDING ON PARCEL ${bestParcel.id}! Attempting pickup...`);
            this.safeInteract('pickup');
            this.currentIntention = 'DELIVER_PARCEL';
            return true;
        }

        return this.moveTowards(px, py);
    }

    executeDeliverParcel(myX, myY) {
        if (!this.deliveryWay) {
            this.deliveryWay = this.getNearestDeliveryZone();
            if (this.deliveryWay) {
                console.log(`🎯 Locked onto delivery zone at (${this.deliveryWay.x}, ${this.deliveryWay.y})`);
            }
        }

        if (!this.deliveryWay) {
            console.log("No reachable delivery zones found! Exploring...");
            this.currentIntention = 'EXPLORE';
            return false;
        }

        const { x: tx, y: ty } = this.deliveryWay;

        if (myX === tx && myY === ty) {
            console.log("📍 Standing on delivery zone! Dropping parcels...");
            const parcelIds = Array.from(this.beliefs.carrying.keys());
            // Clear immediately so a delayed radar update doesn't trick the deliberation
            this.beliefs.carrying.clear();
            this.safeInteract('putdown', parcelIds);
            this.deliveryWay = null;
            this.currentIntention = 'EXPLORE';
            return true;
        }

        const success = this.moveTowards(tx, ty);
        // A* couldn't reach this zone — try a different one next loop
        if (!success) this.deliveryWay = null;
        return success;
    }

    executeExplore(myX, myY) {
        if (this.exploreWay) {
            const { x: wx, y: wy } = this.exploreWay;

            if (myX === wx && myY === wy) {
                console.log("📍 Reached exploration waypoint!");
                this.exploreWay = null;
                return false;
            }
            const success = this.moveTowards(wx, wy);
            if (!success) {
                // If we can't reach this exploration area, pretend we already visited it!
                console.log(`🚫 Exploration target ${wx},${wy} is trapped. Pretending we visited it so we move on.`);
                this.beliefs.visitedTiles.set(`${wx},${wy}`, 1); 
                
                this.exploreWay = null;
            }
            return success;
        }

        // Leapfrog scan: find the closest unvisited tile in chunks of EXPLORE_STEP
        let bestWaypoint = null;
        let shortestDist  = Infinity;
        const maxX = this.beliefs.mapMaxX >= 0 ? this.beliefs.mapMaxX : Infinity;
        const maxY = this.beliefs.mapMaxY >= 0 ? this.beliefs.mapMaxY : Infinity;

        for (let x = myX - EXPLORE_RADIUS; x <= myX + EXPLORE_RADIUS; x += EXPLORE_STEP) {
            for (let y = myY - EXPLORE_RADIUS; y <= myY + EXPLORE_RADIUS; y += EXPLORE_STEP) {
                if (x < 0 || y < 0 || x > maxX || y > maxY) continue;

                const key = `${x},${y}`;
                if (this.beliefs.knownWalls.has(key))  continue;
                if (this.beliefs.unreachable.has(key)) continue;
                if ((this.beliefs.visitedTiles.get(key) || 0) > 0) continue;

                const dist = Math.abs(myX - x) + Math.abs(myY - y);
                if (dist < shortestDist) {
                    shortestDist  = dist;
                    bestWaypoint  = { x, y };
                }
            }
        }

        if (bestWaypoint) {
            console.log(`🧭 Setting new exploration waypoint at (${bestWaypoint.x}, ${bestWaypoint.y})`);
            this.exploreWay = bestWaypoint;
            return this.moveTowards(bestWaypoint.x, bestWaypoint.y);
        } else {
            // If trapped or map is fully explored, forget temporary walls/players and try again!
            console.log("⚠️ I am trapped or map is explored! Clearing temporary walls to escape...");
            this.beliefs.knownWalls = new Set(this.beliefs.mapWalls);
            this.beliefs.unreachable.clear();
            
            const myKey = `${myX},${myY}`;
            const forcedDir = this.beliefs.direction.get(myKey);
            
            if (forcedDir) {
                console.log(`Riding the conveyor belt '${forcedDir}' to escape!`);
                this.safeMove(forcedDir);
            } else {
                // Standard random move
                const dirs = ['up', 'down', 'left', 'right'];
                this.safeMove(dirs[Math.floor(Math.random() * dirs.length)]);
            }
            return true;
        }
    }

    // ─── LOW-LEVEL ACTIONS ───────────────────────────────────────────────────────

    safeMove(direction) {
        this.isActing = true;
        let callbackFired = false;

        let targetX = Math.round(this.beliefs.me.x);
        let targetY = Math.round(this.beliefs.me.y);
        if (direction === 'right') targetX += 1;
        else if (direction === 'left')  targetX -= 1;
        else if (direction === 'up')    targetY += 1;
        else if (direction === 'down')  targetY -= 1;

        this.client.emit('move', direction, (status) => {
            callbackFired = true;

            if (status === false) {
                const key  = `${targetX},${targetY}`;
                const hits = (this.beliefs.collisionCounts.get(key) || 0) + 1;
                this.beliefs.collisionCounts.set(key, hits);

                if (hits >= COLLISION_THRESHOLD) {
                    // Repeated collisions mean it's a permanent wall, not a player
                    console.log(`🧱 Obstacle at ${key} is permanent. Marking as wall.`);
                    this.beliefs.mapWalls.add(key);
                    this.beliefs.knownWalls.add(key);
                } else {
                    // Likely another player; route around it and forgive after timeout
                    console.log(`⚠️ Collision at ${key}! Routing around for ${OBSTACLE_FORGIVE_MS}ms...`);
                    this.beliefs.knownWalls.add(key);
                    setTimeout(() => {
                        if (!this.beliefs.mapWalls.has(key)) {
                            this.beliefs.knownWalls.delete(key);
                            console.log(`Cleared temporary obstacle at ${key}`);
                        }
                    }, OBSTACLE_FORGIVE_MS);
                }
            }

            this.isActing = false;
        });

        // Failsafe: unlock if the server never calls back
        setTimeout(() => {
            if (!callbackFired) this.isActing = false;
        }, MOVE_TIMEOUT_MS);
    }

    safeInteract(action, args = null) {
        this.isActing = true;
        let callbackFired = false;

        const callback = (parcelsAffected) => {
            callbackFired = true;
            const ids = Array.isArray(parcelsAffected) ? parcelsAffected.map(p => p.id) : [];
            console.log(`✅ '${action}' completed. Parcels: ${ids.length > 0 ? ids.join(', ') : 'None'}`);

            if (action === 'pickup' && Array.isArray(parcelsAffected)) {
                parcelsAffected.forEach(p => this.beliefs.carrying.set(p.id, p));
            } else if (action === 'putdown') {
                this.beliefs.carrying.clear();
            }

            // Short delay lets the server radar catch up before the next decision cycle
            setTimeout(() => { this.isActing = false; }, INTERACT_UNLOCK_DELAY_MS);
        };

        if (args) this.client.emit(action, args, callback);
        else      this.client.emit(action, callback);

        // Failsafe: unlock if the server never responds
        setTimeout(() => {
            if (!callbackFired) {
                console.log(`⚠️ Server did not respond to '${action}'. Unlocking.`);
                if (action === 'putdown') this.beliefs.carrying.clear();
                this.isActing = false;
            }
        }, INTERACT_TIMEOUT_MS);
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────────

    getNearestDeliveryZone() {
        if (this.beliefs.deliveryZones.size === 0) return null;

        const myX = Math.round(this.beliefs.me.x);
        const myY = Math.round(this.beliefs.me.y);
        let nearest     = null;
        let shortestDist = Infinity;

        for (const zoneStr of this.beliefs.deliveryZones) {
            const [zx, zy] = zoneStr.split(',').map(Number);
            const dist = Math.abs(myX - zx) + Math.abs(myY - zy);

            // Forgive zones that were blocked if we're now nearby
            if (dist <= PROXIMITY_FORGIVE_DIST) this.beliefs.unreachable.delete(zoneStr);
            if (this.beliefs.unreachable.has(zoneStr)) continue;

            if (dist < shortestDist) {
                shortestDist = dist;
                nearest      = { x: zx, y: zy };
            }
        }
        return nearest;
    }

    moveTowards(tx, ty) {
        const myX = Math.round(this.beliefs.me.x);
        const myY = Math.round(this.beliefs.me.y);
        const direction = aStar(this.beliefs, myX, myY, tx, ty, this.beliefs.knownWalls, this.beliefs.mapMaxX, this.beliefs.mapMaxY);

        if (direction) {
            this.safeMove(direction);
            return true;
        }

        const targetKey = `${tx},${ty}`;
        console.log(`❌ Target ${targetKey} is unreachable. Will reconsider in ${UNREACHABLE_RECONSIDER_MS}ms.`);
        this.beliefs.unreachable.add(targetKey);
        setTimeout(() => {
            this.beliefs.unreachable.delete(targetKey);
            console.log(`⏱️ Reconsidering previously unreachable target ${targetKey}.`);
        }, UNREACHABLE_RECONSIDER_MS);
        return false;
    }
}
