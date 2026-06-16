import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import { onlineSolver } from '@unitn-asa/pddl-client'
import { createBeliefs, updateMapBeliefs, updateParcelBeliefs, updateAgentsBeliefs } from './beliefs.js';
import { aStar } from './pathfinding.js';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
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
    constructor(emitter) {
        this.teamRadio = emitter;
        this.client = new DjsConnect(process.env.BDI_URL, process.env.BDI_TOKEN);
        this.beliefs = createBeliefs();
        
        this.exploreWay = null;
        this.deliveryWay = null;
        this.currentIntention = 'EXPLORE';
        this.llmOverride = null;
        this.isActing = false;
        this.pddlPlan = [];
    }

    async start() {
        console.log("Starting BDI Agent...");

        // Load the PDDL domain file
        try {
            const domainPath = path.resolve('./pddl/domain.pddl'); 
            this.domainString = await readFile(domainPath, 'utf-8');
            console.log("📜 PDDL Domain successfully loaded into memory!");
        } catch (error){
            console.error("❌ Failed to load domain.pddl! Check the file path.", error);
            process.exit(1); // Kill the agent if it can't find its brain
        }
        // Listen for orders from Agent B
        this.teamRadio.on('strategy_change', (newStrategy) => {
            console.log(`\n🗣️ [RADIO RECEIVER] LLM commanded me to: ${newStrategy}`);
            
            // If the LLM says 'PAUSE', we clear the override when we want it to resume normal AI behavior
            if (newStrategy === 'DROP_PARCEL') {
                console.log("📦 Executing tactical relay drop!");
                const parcelIds = Array.from(this.beliefs.carrying.keys());
                if (parcelIds.length > 0) {
                    this.safeInteract('putdown', parcelIds);
                }
                this.llmOverride = 'PAUSE'; // Wait for Agent B to come get it
            } 
            else if (newStrategy === 'RESUME_NORMAL') {
                this.llmOverride = null;
            } else {
                this.llmOverride = newStrategy;
            }
        });

        this.teamRadio.on('request_status', (callback) => {
            const status = {
                x: (this.beliefs.me.x !== undefined && this.beliefs.me.x  !== null) ? Math.round(this.beliefs.me.x ) : 'Unknown',
                y: (this.beliefs.me.y !== undefined && this.beliefs.me.y  !== null) ? Math.round(this.beliefs.me.y ) : 'Unknown',
                intention: this.currentIntention,
                parcelsKnown: this.beliefs.parcels.size,
                carrying: this.beliefs.carrying.size
            };
            
            console.log(`📡 [RADIO TRANSMITTER] Sending status to LLM:`, status);
            callback(status); // Send the data back to the LLM
        });

        this.teamRadio.on('go_to', (coords) => {
            console.log(`\n🗣️ [RADIO RECEIVER] LLM commanded me to GO_TO: ${coords.x}, ${coords.y}`);
            this.pddlPlan = [];
            this.llmOverride = 'GO_TO';
            this.overrideTarget = { x: parseInt(coords.x), y: parseInt(coords.y) };
        });

        this.client.on('map',     (tiles) => updateMapBeliefs(this.beliefs, tiles));
        this.client.on('tile',    (tile)  => updateMapBeliefs(this.beliefs, [tile]));
        this.client.on('you',     (me)    => { this.beliefs.me = me; });
        this.client.on('sensing', (data)  => {
            updateParcelBeliefs(this.beliefs, data.parcels ?? data);
            updateAgentsBeliefs(this.beliefs, data.agents);
        });
        this.client.on('config', (config) => {
            console.log("📜 Game Rules loaded!");
            if (config.parcels) {
                console.log(`Parcels spawn every: ${config.parcels.generation_event}`);
                console.log(`Max parcels allowed on map: ${config.parcels.max}`);
            }
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

        // Skip while the game engine is animating the move
        const isMidStride =
            Math.abs(this.beliefs.me.x - Math.round(this.beliefs.me.x)) > 0.1 ||
            Math.abs(this.beliefs.me.y - Math.round(this.beliefs.me.y)) > 0.1;
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

        // Determine normal BDI intention and store it in baseIntention
        let baseIntention = 'EXPLORE';
        
        if (isFull && knowsDelivery) {
            baseIntention = 'DELIVER_PARCEL';
        } else if (seesParcels && !isFull) {
            baseIntention = 'GET_PARCEL';
        } else if (hasParcels && knowsDelivery) {
            baseIntention = 'DELIVER_PARCEL';
        }

        // Apply LLM override if one exists
        this.currentIntention = this.llmOverride ? this.llmOverride : baseIntention;

        // If the LLM commanded a PAUSE, do nothing this loop
        if (this.currentIntention === 'PAUSE') {
            this.isActing = false;
            return; 
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
            case 'PAUSE':          return true;
            case 'GO_TO':          return this.moveTowards(this.overrideTarget.x, this.overrideTarget.y);
            case 'GET_PARCEL':     return this.executeGetParcel(myX, myY);
            case 'DROP_PARCEL':    return this.safeInteract('putdown');
            case 'DELIVER_PARCEL': return this.executeDeliverParcel(myX, myY);
            case 'EXPLORE':        return this.executeExplore(myX, myY);
            default:               return false;
        }
    }

    executeGetParcel(myX, myY) {
        let bestParcel = null;
        let maxReward  = -Infinity;

        // Find the best parcel
        for (const parcel of this.beliefs.parcels.values()) {
            const px = Math.round(parcel.x);
            const py = Math.round(parcel.y);
            const key = `${px},${py}`;

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

        if (myX === px && myY === py) {
            console.log(`📦 STANDING ON PARCEL ${bestParcel.id}! Attempting pickup...`);
            this.safeInteract('pickup');
            return true;
        }

        return this.moveTowards(px, py);
    }

    executeDeliverParcel(myX, myY) {
        // If we already have a plan, execute the next step!
        if (this.pddlPlan && this.pddlPlan.length > 0) {
            const nextStep = this.pddlPlan.shift();
            this.translateAndExecutePDDL(nextStep);
            
            if (this.pddlPlan.length === 0) {
                 this.currentIntention = 'EXPLORE'; // Done delivering
            }
            return true;
        }

        if (!this.deliveryWay) {
            this.deliveryWay = this.getNearestDeliveryZone();
        }

        if (!this.deliveryWay) {
            this.currentIntention = 'EXPLORE';
            return false;
        }

        const { x: tx, y: ty } = this.deliveryWay;
        console.log(`[DELIVER_PARCEL] Asking PDDL Planner to route to (${tx}, ${ty})`);
        const targetKey = `${tx},${ty}`;
        const problemString = this.generateProblemString('DELIVER', tx, ty);
        
        this.fetchPlan(this.domainString, problemString, targetKey);
        return true;
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

        // Find the closest parcel Spawn
        if (this.beliefs.parcelZones.size > 0) {
            let nearestSpawner = null;
            let shortestDist = Infinity;

            for (const spawnerStr of this.beliefs.parcelZones) {
                const [sx, sy] = spawnerStr.split(',').map(Number);
                
                // Skip if A* previously told us this spawner is blocked by traffic
                if (this.beliefs.unreachable.has(spawnerStr)) continue;

                const dist = Math.abs(myX - sx) + Math.abs(myY - sy);
                if (dist < shortestDist) {
                    shortestDist = dist;
                    nearestSpawner = { x: sx, y: sy };
                }
            }

            if (nearestSpawner) {
                console.log(`🕵️ Patrolling nearest parcel spawner at (${nearestSpawner.x}, ${nearestSpawner.y})`);
                this.exploreWay = nearestSpawner;
                return this.moveTowards(nearestSpawner.x, nearestSpawner.y);
            }
        }

        // Fallback: Leapfrog scan (if no spawners known, or all are unreachable)
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
            console.log(`🧭 Setting new Leapfrog scan waypoint at (${bestWaypoint.x}, ${bestWaypoint.y})`);
            this.exploreWay = bestWaypoint;
            return this.moveTowards(bestWaypoint.x, bestWaypoint.y);
        } else {
            console.log("⚠️ I am trapped or map is explored! Clearing temporary walls to escape...");
            this.beliefs.knownWalls = new Set(this.beliefs.mapWalls);
            this.beliefs.unreachable.clear();
            
            const myKey = `${myX},${myY}`;
            const forcedDir = this.beliefs.direction?.get(myKey); // Added the failsafe ? here too!
            
            if (forcedDir) {
                console.log(`Riding the conveyor belt '${forcedDir}' to escape!`);
                this.safeMove(forcedDir);
            } else {
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
                this.pddlPlan = [];
                const key  = `${targetX},${targetY}`;
                const hits = (this.beliefs.collisionCounts.get(key) || 0) + 1;
                this.beliefs.collisionCounts.set(key, hits);

                let isPlayer = false;
                for (const agent of this.beliefs.agents.values()) {
                    if (Math.round(agent.x) === targetX && Math.round(agent.y) === targetY) {
                        isPlayer = true;
                        break;
                    }
                }

                if (hits >= COLLISION_THRESHOLD && !isPlayer) {
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
        //console.log(`❌ Target ${targetKey} is unreachable. Will reconsider in ${UNREACHABLE_RECONSIDER_MS}ms.`);
        this.beliefs.unreachable.add(targetKey);
        setTimeout(() => {
            this.beliefs.unreachable.delete(targetKey);
            //console.log(`⏱️ Reconsidering previously unreachable target ${targetKey}.`);
        }, UNREACHABLE_RECONSIDER_MS);
        return false;
    }

    // ─── PDDL PLANNING ──────────────────────────────────────────────────────────

   async fetchPlan(domainString, problemString, targetKey = null) {
        console.log("🧠 Asking PDDL Planner for a strategy...");
        this.isActing = true; 

        try {
            const plan = await onlineSolver(domainString, problemString); 
            
            if (plan && plan.length > 0) {
                console.log("✅ PDDL Plan found with", plan.length, "steps!");
                this.pddlPlan = plan; 
            } else {
                console.log("⚠️ Planner returned an empty plan. Target might be blocked.");
                this.pddlPlan = [];
                
                if (targetKey) {
                    this.beliefs.unreachable.add(targetKey);
                    setTimeout(() => {
                        this.beliefs.unreachable.delete(targetKey);
                    }, UNREACHABLE_RECONSIDER_MS);
                }
            }
        } catch (error) {
            console.error("❌ PDDL Planner failed:", error.message);
            this.pddlPlan = [];
            
            if (targetKey) {
                this.beliefs.unreachable.add(targetKey);
                setTimeout(() => {
                    this.beliefs.unreachable.delete(targetKey);
                }, UNREACHABLE_RECONSIDER_MS);
            }
        } finally {
            this.isActing = false; 
        }
    }

    generateProblemString(goalType, targetX = null, targetY = null) {
        let objects = "";
        let init = "";
        
        const myX = Math.round(this.beliefs.me.x);
        const myY = Math.round(this.beliefs.me.y);
        
        // Define the Agent's location
        init += `    (at-agent loc-${myX}-${myY})\n`;

        // Only generate the map within a small radius around the agent and target
        const buffer = 4; // Extra tiles to allow routing around obstacles
        const safeTargetX = targetX !== null ? targetX : myX;
        const safeTargetY = targetY !== null ? targetY : myY;

        const startX = Math.max(0, Math.min(myX, safeTargetX) - buffer);
        const endX = Math.min(this.beliefs.mapMaxX > 0 ? this.beliefs.mapMaxX : 20, Math.max(myX, safeTargetX) + buffer);
        
        const startY = Math.max(0, Math.min(myY, safeTargetY) - buffer);
        const endY = Math.min(this.beliefs.mapMaxY > 0 ? this.beliefs.mapMaxY : 20, Math.max(myY, safeTargetY) + buffer);
        
        for (let x = startX; x <= endX; x++) {
            for (let y = startY; y <= endY; y++) {
                const key = `${x},${y}`;
                if (this.beliefs.knownWalls.has(key)) continue; 

                objects += `loc-${x}-${y} `;
                
                // Connect Right (ensure we don't connect outside our bounding box)
                if (x + 1 <= endX && !this.beliefs.knownWalls.has(`${x+1},${y}`)) {
                    init += `    (connected loc-${x}-${y} loc-${x+1}-${y})\n`;
                    init += `    (connected loc-${x+1}-${y} loc-${x}-${y})\n`;
                }
                // Connect Up (ensure we don't connect outside our bounding box)
                if (y + 1 <= endY && !this.beliefs.knownWalls.has(`${x},${y+1}`)) {
                    init += `    (connected loc-${x}-${y} loc-${x}-${y+1})\n`;
                    init += `    (connected loc-${x}-${y+1} loc-${x}-${y})\n`;
                }
            }
        }

        // Define Parcels or Delivery Zones based on our exact goal
        let goal = "";

        if (goalType === 'PICKUP') {
            objects += `- location\n    target_parcel - parcel`;
            init += `    (at-parcel target_parcel loc-${targetX}-${targetY})\n`;
            goal = `(carrying target_parcel)`;
        } else if (goalType === 'DELIVER') {
            objects += `- location\n    carried_parcel - parcel`;
            init += `    (carrying carried_parcel)\n`;
            init += `    (is-delivery-zone loc-${targetX}-${targetY})\n`;
            goal = `(delivered carried_parcel)`;
        }

        return `(define (problem deliveroo-dynamic)
                (:domain deliveroo)
                (:objects 
                    ${objects}
                )
                (:init 
                ${init}  )
                (:goal 
                    ${goal}
                )
                )`;
    }

    translateAndExecutePDDL(pddlStep) {
        console.log(`🤖 PDDL Translating:`, pddlStep); // This will print the actual object so we can see it!
        
        try {
            let action = "";
            let args = [];

            // Safe extraction: Handle both strings and PddlAction objects
            if (typeof pddlStep === 'string') {
                const parts = pddlStep.replace(/[()]/g, '').toLowerCase().split(' ');
                action = parts[0];
                args = parts.slice(1);
            } 
            else if (typeof pddlStep === 'object') {
                // Extract action (handling different possible naming conventions in the package)
                action = (pddlStep.action || pddlStep.name || "").toLowerCase();
                // Extract arguments safely
                args = pddlStep.args ? pddlStep.args.map(a => a.toLowerCase()) : [];
            }

            // Execute the extracted logic
            if (action === 'move') {
                const from = args[0].split('-'); // "loc", "5", "26"
                const to = args[1].split('-');   // "loc", "5", "27"
                
                const fromX = parseInt(from[1]);
                const fromY = parseInt(from[2]);
                const toX = parseInt(to[1]);
                const toY = parseInt(to[2]);

                let dir = 'up';
                if (toX > fromX) dir = 'right';
                if (toX < fromX) dir = 'left';
                if (toY > fromY) dir = 'up';
                if (toY < fromY) dir = 'down';

                this.safeMove(dir);
            } 
            else if (action === 'pickup') {
                this.safeInteract('pickup');
            } 
            else if (action === 'drop-at-delivery') {
                const parcelIds = Array.from(this.beliefs.carrying.keys());
                this.safeInteract('putdown', parcelIds);
            } 
            else {
                console.log(`⚠️ Unrecognized PDDL action: ${action}`);
                this.pddlPlan = []; // Abort the plan if we don't know what to do
            }
            
        } catch (error) {
            console.error("❌ Failed to translate PDDL step:", error);
            this.pddlPlan = []; // Clear the broken plan so the BDI loop doesn't spam errors
        }
    }
}

