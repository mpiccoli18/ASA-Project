// Importing main libraries
import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';

class BDIAgent {
    constructor() {
        this.client = new DjsConnect(
          process.env.URL,
          process.env.TOKEN
        );

        this.beliefs = {
            me: { id: null, name: '', x: undefined, y: undefined, score: 0, penalty: 0},
            deliveryZones: new Set(), 
            parcels: new Map(),       
            carrying: new Map(),       
            visitedTiles: new Map(),  
            mapWalls: new Set(),      // Permanent walls given by the map
            knownWalls: new Set(),    // Temporary walls (map walls + out-of-bounds/players)
            unreachable: new Set(),    // Parcels or zones A* couldn't find a path to
    
            collisionCounts: new Map(), // Track collision 
            mapMaxX: 0,
            mapMaxY: 0
        };

        this.exploreWay = null;
        this.deliveryWay = null;
        this.currentIntention = 'EXPLORE';
        this.isActing = false;
    }

    async start() {
        console.log("Starting BDI Agent...");

        this.client.on('map', (tiles) => this.updateMapBeliefs(tiles));
        
        this.client.on('tile', (tile) => this.updateMapBeliefs([tile]));

        this.client.on('you', (me) => {
            this.beliefs.me = me;
        });
        
        this.client.on('sensing', (sensingData) => {
            // Let's grab just the parcels array, or default to the raw data just in case
            const parcelsData = sensingData.parcels ? sensingData.parcels : sensingData;
            
            this.updateParcelBeliefs(parcelsData);
        });

        process.on('SIGINT', () => {
            console.log("\nCTRL+C detected. Disconnecting agent...");
            if (this.client) this.client.disconnect();
            process.exit(0);
        });
        
        setInterval(() => this.bdiLoop(), 250);
    }

    // --- BELIEF REVISION ---

    updateMapBeliefs(tiles) {
        if (!Array.isArray(tiles)) return;
        
        let newZonesFound = 0;
        
        tiles.forEach(tile => {
            // Track map boundaries
            if (tile.x > this.beliefs.mapMaxX) this.beliefs.mapMaxX = tile.x;
            if (tile.y > this.beliefs.mapMaxY) this.beliefs.mapMaxY = tile.y;

            const posKey = `${tile.x},${tile.y}`;
            
            if (tile.type === 2 || tile.type === '2' || tile.delivery || tile.deliveryZone || tile.type === 'delivery') {
                // Only count it if we haven't seen it before!
                if (!this.beliefs.deliveryZones.has(posKey)) {
                    this.beliefs.deliveryZones.add(posKey);
                    newZonesFound++;
                }
            }
            if (tile.type === 0 || tile.type === '0' || tile.wall || tile.type === 'wall') {
                this.beliefs.mapWalls.add(posKey);
                this.beliefs.knownWalls.add(posKey);
            }
        });
        
        // Brag about what we just found during exploration!
        if (newZonesFound > 0) {
            console.log(`🗺️ EXPLORATION DISCOVERY: Memorized ${newZonesFound} new delivery zone(s)! (Total known: ${this.beliefs.deliveryZones.size})`);
        }
    }

    updateParcelBeliefs(parcelsData) {
        this.beliefs.parcels.clear(); // Only clear ground vision! Do NOT clear carrying.

        if (!parcelsData) return;

        let parcelsList = [];
        if (Array.isArray(parcelsData)) parcelsList = parcelsData;
        else if (parcelsData instanceof Map) parcelsList = Array.from(parcelsData.values());
        else if (typeof parcelsData === 'object') parcelsList = Object.values(parcelsData);

        parcelsList.forEach(p => {
            if (!p || typeof p !== 'object') return;
            
            const actualParcel = p.parcel ? { ...p.parcel, x: p.x, y: p.y } : p;
            if (!actualParcel.id) return;

            actualParcel.reward = Number(actualParcel.reward) || 1;
            
            // If the radar somehow still sees it in our hands, update it
            if (actualParcel.carriedBy === this.beliefs.me.id) {
                this.beliefs.carrying.set(actualParcel.id, actualParcel);
            } else if (!actualParcel.carriedBy || actualParcel.carriedBy === 'none') {
                this.beliefs.parcels.set(actualParcel.id, actualParcel);
            }
        });
    }

    // --- DELIBERATION ---

    async bdiLoop() {
        if (this.beliefs.me.x === undefined || this.beliefs.me.y === undefined) return; 
        if (this.isActing) return;

        // If our coordinate is a float, the game engine is moving us. Do nothing!
        const isMidStride = (Math.abs(this.beliefs.me.x - Math.round(this.beliefs.me.x)) > 0.3) || 
                            (Math.abs(this.beliefs.me.y - Math.round(this.beliefs.me.y)) > 0.3);
        if (isMidStride) return;

        const MAX_CARRY = 3;

        const isFull = this.beliefs.carrying.size >= MAX_CARRY;
        const hasParcels = this.beliefs.carrying.size > 0;
        const seesParcels = this.beliefs.parcels.size > 0;
        const knowsDelivery = this.beliefs.deliveryZones.size > 0;
        const myX = Math.round(this.beliefs.me.x);
        const myY = Math.round(this.beliefs.me.y);
        const posKey = `${myX},${myY}`;
        
        const currentVisits = this.beliefs.visitedTiles.get(posKey) || 0;
        this.beliefs.visitedTiles.set(posKey, currentVisits + 1);

        if (isFull && knowsDelivery) {
            // Backpack is completely full. Time to deliver!
            this.currentIntention = 'DELIVER_PARCEL';
        } else if (seesParcels && !isFull) {
            // We see parcels on the ground AND we have room in the backpack. Grab them!
            this.currentIntention = 'GET_PARCEL';
        } else if (hasParcels && knowsDelivery) {
            // We have some parcels, but the radar is empty. Don't waste time exploring, go deliver!
            this.currentIntention = 'DELIVER_PARCEL';
        } else {
            // Nothing to grab, or we are holding boxes but don't know where the red squares are yet.
            this.currentIntention = 'EXPLORE';
        }

        // If we switch tasks, forget our old waypoints so we calculate fresh, closer ones later!
        if (this.currentIntention !== 'DELIVER_PARCEL') {
            this.deliveryWaypoint = null;
        }
        if (this.currentIntention !== 'EXPLORE') {
            this.exploreWaypoint = null;
        }

        this.isActing = true;
        let actionTaken = false;
        
        try {
            actionTaken = this.executeIntention(myX, myY);
        } catch (error) {
            console.error("Action failed:", error);
        } 

        if (!actionTaken) {
            this.isActing = false;
        }
    }

    // --- ACTION EXECUTION ---

    executeIntention(myX, myY) {

        if (this.currentIntention === 'GET_PARCEL') {
            let bestParcel = null;
            let maxReward = -Infinity;
            
            for (const [id, parcel] of this.beliefs.parcels.entries()) {
                const px = Math.round(parcel.x);
                const py = Math.round(parcel.y);
                
                const dist = Math.abs(myX - px) + Math.abs(myY - py);
                if (dist <= 2 && this.beliefs.unreachable.has(`${px},${py}`)) {
                    this.beliefs.unreachable.delete(`${px},${py}`);
                }

                if (this.beliefs.unreachable.has(`${px},${py}`)) continue;

                if (parcel.reward > maxReward) {
                    maxReward = parcel.reward;
                    bestParcel = parcel;
                }
            }

            if (bestParcel) {
                // FORCE MATH TO BE INTEGERS JUST IN CASE
                const px = parseInt(Math.round(bestParcel.x));
                const py = parseInt(Math.round(bestParcel.y));
                const agentX = parseInt(myX);
                const agentY = parseInt(myY);

                // Print exactly what the agent sees
                console.log(`[DEBUG GET_PARCEL] Me: (${agentX}, ${agentY}) | Parcel: (${px}, ${py}) | Match? ${agentX === px && agentY === py}`);

                if (agentX === px && agentY === py) {
                    console.log(`📦 STANDING ON PARCEL ${bestParcel.id}! Attempting pickup...`);
                    this.safeInteract('pickup'); 
                    this.currentIntention = 'DELIVER_PARCEL';
                    return true;
                } else {
                    return this.moveTowards(px, py);
                }
            } else {
                this.currentIntention = 'EXPLORE';
            }
        }

        if (this.currentIntention === 'DELIVER_PARCEL') {
            // If we don't have a delivery waypoint yet, find the closest one NOW and lock onto it.
            if (!this.deliveryWay) {
                this.deliveryWay = this.getNearestDeliveryZone();
                if (this.deliveryWay) {
                    console.log(`🎯 Locked onto delivery zone at ${this.deliveryWay.x}, ${this.deliveryWay.y}`);
                }
            }

            // If we successfully locked onto a zone, walk to it!
            if (this.deliveryWay) {
                const tx = this.deliveryWay.x;
                const ty = this.deliveryWay.y;

                if (myX === tx && myY === ty) {
                    console.log("📍 Standing on delivery zone! Dropping parcels...");
                    
                    // Get the exact IDs we want to drop
                    const parcelIdsToDrop = Array.from(this.beliefs.carrying.keys());
                    
                    // Wipe the backpack immediately so delayed radar doesn't trick us
                    this.beliefs.carrying.clear();
                    
                    // Send the command
                    this.safeInteract('putdown', parcelIdsToDrop); 
                    
                    // Force the brain back into explore mode
                    this.deliveryWaypoint = null; 
                    this.currentIntention = 'EXPLORE';
                    return true;
                } else {
                    const success = this.moveTowards(tx, ty);
                    if (!success) {
                        // If A* says the zone is blocked, clear the waypoint so we pick a different one next loop!
                        this.deliveryWay = null;
                    }
                    return success;
                }
            } else {
                console.log("No reachable delivery zones found! Exploring...");
                this.currentIntention = 'EXPLORE';
            }
        }

        if (this.currentIntention === 'EXPLORE') {
            // If we already have a distant waypoint, keep using A* to walk to it!
            if (this.exploreWay) {
                const wx = this.exploreWay.x;
                const wy = this.exploreWay.y;

                // Did we reach it?
                if (myX === wx && myY === wy) {
                    console.log("📍 Reached exploration waypoint!");
                    this.exploreWay = null; // Clear it so we pick a new one next loop
                    return false; 
                }

                // Ask A* to take us there
                const success = this.moveTowards(wx, wy);
                if (!success) {
                    // If A* says it's unreachable (blocked by walls), abandon the waypoint
                    this.exploreWay = null;
                }
                return success;
            }

            // We don't have a waypoint. Let's find a distant unvisited area!
            let bestWaypoint = null;
            let shortestDist = Infinity;

            // Scan the map around us in chunks of 4 (leveraging our vision radius)
            for (let x = myX - 20; x <= myX + 20; x += 4) { 
                for (let y = myY - 20; y <= myY + 20; y += 4) {
                    const key = `${x},${y}`;
                    
                    const maxX = this.beliefs.mapMaxX >= 0 ? this.beliefs.mapMaxX : Infinity;
                    const maxY = this.beliefs.mapMaxY >= 0 ? this.beliefs.mapMaxY : Infinity;

                    if(x < 0 || y < 0 || x > maxX || y > maxY){
                        continue; //Skip out-of-bounds places
                    } 
                    
                    // Ignore solid walls and places we know we can't reach
                    if (this.beliefs.knownWalls.has(key)) continue;
                    if (this.beliefs.unreachable.has(key)) continue;

                    const visits = this.beliefs.visitedTiles.get(key) || 0;
                    
                    if (visits === 0) {
                        // Find the CLOSEST unvisited chunk using Manhattan distance
                        const dist = Math.abs(myX - x) + Math.abs(myY - y);
                        if (dist < shortestDist) {
                            shortestDist = dist;
                            bestWaypoint = { x, y };
                        }
                    }
                }
            }

            // Set the new waypoint and start moving!
            if (bestWaypoint){
                console.log(`🧭 Setting new Leapfrog Waypoint at ${bestWaypoint.x}, ${bestWaypoint.y}`);
                this.exploreWay = bestWaypoint;
                return this.moveTowards(bestWaypoint.x, bestWaypoint.y);
            } 
            else{
                // If trapped or map is fully explored, forget temporary walls/players and try again!
                console.log("⚠️ I am trapped or map is explored! Clearing temporary walls to escape...");
                this.beliefs.knownWalls = new Set(this.beliefs.mapWalls);
                this.beliefs.unreachable.clear();
                
                // Force a random move just to push against the boundary
                const dirs = ['up', 'down', 'left', 'right'];
                this.safeMove(dirs[Math.floor(Math.random() * dirs.length)]);
                return true;
            }
        }
        return false;
    }

    safeMove(direction) {
        this.isActing = true;
        let callbackFired = false;

        let targetX = Math.round(this.beliefs.me.x);
        let targetY = Math.round(this.beliefs.me.y);
        
        if (direction === 'right') targetX += 1;
        else if (direction === 'left') targetX -= 1;
        else if (direction === 'up') targetY += 1;
        else if (direction === 'down') targetY -= 1;

        this.client.emit('move', direction, (status) => {
            callbackFired = true;
            
            if (status === false) {
                const obstacleKey = `${targetX},${targetY}`;
                
                // Track how many times we've bumped into this exact tile
                const hits = (this.beliefs.collisionCounts.get(obstacleKey) || 0) + 1;
                this.beliefs.collisionCounts.set(obstacleKey, hits);

                if (hits >= 2) {
                    // This is not a player, it is a permanent wall!
                    console.log(`🧱 Obstacle at ${obstacleKey} seems permanent! Marking as solid map wall.`);
                    this.beliefs.mapWalls.add(obstacleKey);
                    this.beliefs.knownWalls.add(obstacleKey);
                } else {
                    // It might be a player, forgive it in 2 seconds.
                    console.log(`⚠️ Collision at ${obstacleKey}! Routing around it for 2 seconds...`);
                    this.beliefs.knownWalls.add(obstacleKey);
                    
                    setTimeout(() => {
                        // Only clear it if it hasn't been upgraded to a permanent wall!
                        if (!this.beliefs.mapWalls.has(obstacleKey)) {
                            this.beliefs.knownWalls.delete(obstacleKey);
                            console.log(`Cleared temporary obstacle at ${obstacleKey}`);
                        }
                    }, 500); 
                }
            }
            
            this.isActing = false; 
        });

        setTimeout(() => { 
            if (!callbackFired) {
                this.isActing = false; 
            } 
        }, 100);
    }

    safeInteract(action, args = null) {
        this.isActing = true;
        let callbackFired = false;

        const callback = (parcelsAffected) => {
            callbackFired = true;
            let ids = Array.isArray(parcelsAffected) ? parcelsAffected.map(p => p.id) : [];
            console.log(`✅ Action '${action}' completed! Affected parcels:`, ids.length > 0 ? ids.join(', ') : 'None');

            if (action === 'pickup' && Array.isArray(parcelsAffected)) {
                parcelsAffected.forEach(p => this.beliefs.carrying.set(p.id, p));
            } else if (action === 'putdown') {
                this.beliefs.carrying.clear(); // Ensure it stays clear!
            }

            // Wait 800ms to let the server radar catch up to reality!
            setTimeout(() => {
                this.isActing = false;
            }, 100); 
        };

        if (args) this.client.emit(action, args, callback);
        else this.client.emit(action, callback);

        // Shorter failsafe so it doesn't hang forever
        setTimeout(() => { 
            if (!callbackFired) {
                console.log(`⚠️ Server did not respond to ${action}. Unlocking.`);
                // If it was a putdown, trust that we dropped it and walk away
                if (action === 'putdown') this.beliefs.carrying.clear(); 
                this.isActing = false; 
            } 
        }, 500);
    }

    // --- HELPER METHODS ---

    getNearestDeliveryZone() {
        if (this.beliefs.deliveryZones.size === 0) return null;
        
        let nearest = null;
        let minDxDySq = Infinity;
        const myX = Math.round(this.beliefs.me.x);
        const myY = Math.round(this.beliefs.me.y);

        for (const zoneStr of this.beliefs.deliveryZones) {
            const [zx, zy] = zoneStr.split(',').map(Number);
            
            // Forgive unreachable zones if we are close!
            const distToZone = Math.abs(myX - zx) + Math.abs(myY - zy);
            if (distToZone <= 2 && this.beliefs.unreachable.has(zoneStr)) {
                console.log(`Forgiving unreachable delivery zone at ${zoneStr}!`);
                this.beliefs.unreachable.delete(zoneStr);
            }

            // Skip if it is currently marked as blocked by a wall
            if (this.beliefs.unreachable.has(zoneStr)) continue;

            const distSq = (myX - zx) ** 2 + (myY - zy) ** 2;
            if (distSq < minDxDySq) {
                minDxDySq = distSq;
                nearest = { x: zx, y: zy };
            }
        }
        return nearest;
    }

    moveTowards(tx, ty) {
        const myX = Math.round(this.beliefs.me.x);
        const myY = Math.round(this.beliefs.me.y);
        
        const nextDirection = this.aStarAlgorithm(myX, myY, tx, ty);

        if (nextDirection) {
            this.safeMove(nextDirection);
            return true;
        } else {
            console.log(`❌ Target ${tx},${ty} is unreachable! Remembering to ignore it.`);
            this.beliefs.unreachable.add(`${tx},${ty}`); 
            return false;
        }
    }

    aStarAlgorithm(startX, startY, targetX, targetY) {
        const heuristic = (x, y) => Math.abs(targetX - x) + Math.abs(targetY - y);
        const openSet = [{ x: startX, y: startY, g: 0, f: heuristic(startX, startY), path: [] }];
        const closedSet = new Set();

        const moves = [
            { dir: 'up',    dx: 0,  dy: 1 },
            { dir: 'down',  dx: 0,  dy: -1 },
            { dir: 'right', dx: 1,  dy: 0 },
            { dir: 'left',  dx: -1, dy: 0 }
        ];

        while (openSet.length > 0) {
            openSet.sort((a, b) => a.f - b.f);
            const current = openSet.shift();

            if (current.x === targetX && current.y === targetY) {
                return current.path.length > 0 ? current.path[0] : null;
            }

            const currentKey = `${current.x},${current.y}`;
            if (closedSet.has(currentKey)) continue;
            closedSet.add(currentKey);

            for (const move of moves) {
                const nextX = current.x + move.dx;
                const nextY = current.y + move.dy;
                const nextKey = `${nextX},${nextY}`;

                // Stop A* from searching the infinite void outside the map!
                const maxX = this.beliefs.mapMaxX > 0 ? this.beliefs.mapMaxX + 2 : 50;
                const maxY = this.beliefs.mapMaxY > 0 ? this.beliefs.mapMaxY + 2 : 50;
                if (nextX < -2 || nextY < -2 || nextX > maxX || nextY > maxY) continue;

                if (closedSet.has(nextKey)) continue;
                if (this.beliefs.knownWalls.has(nextKey)) continue;

                const gScore = current.g + 1; 
                const fScore = gScore + heuristic(nextX, nextY);

                openSet.push({
                    x: nextX, y: nextY, g: gScore, f: fScore,
                    path: [...current.path, move.dir] 
                });
            }
        }
        return null;
    }
}

const agent = new BDIAgent();
agent.start();