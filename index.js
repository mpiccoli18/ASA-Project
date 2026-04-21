// Importing main libraries
import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';

class BDIAgent {
    constructor() {
        // Defining socket connection
        this.client = new DjsConnect(
          process.env.URL,
          process.env.TOKEN
        );

        // --- BELIEFS (Memory) ---
        // We must store information here because we only see a 5-tile radius.
        this.beliefs = {
            me: { id: null, name: '', x: 5, y: 5, score: 0, penalty: 0 },
            deliveryZones: new Set(), // Remember red tiles (type 2) 
            parcels: new Map(),       // Currently visible parcels on the ground
            carrying: new Map()       // Parcels we are currently holding [cite: 51]
        };

        // --- INTENTIONS (Current Goal) ---
        this.currentIntention = 'EXPLORE';
        
        // --- LOCK (To prevent action spamming) ---
        // Moving takes time. We shouldn't send another move command while moving.
        this.isActing = false; 
    }

    async start() {
        console.log("Starting BDI Agent...");

        //console.log("Available SDK methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(this.client)));
        // SENSE: Listen for environment updates and update Beliefs
        // (Note: Verify exact event names and payload structures in the Deliveroo.js SDK docs)
        
        // Map updates (received on connection) [cite: 84]
        this.client.on('map', (tiles) => this.updateMapBeliefs(tiles));
        
        // Personal state updates [cite: 100]
        this.client.on('you', (me) => {
            this.beliefs.me = me;
        });
        
        // Parcel updates in our sensing radius [cite: 97]
        this.client.on('parcels', (parcelsData) => this.updateParcelBeliefs(parcelsData));
        
        // DELIBERATE: Start the BDI Loop
        // Runs continuously to evaluate what to do next
        setInterval(() => this.bdiLoop(), 100);
    }

    // --- BELIEF REVISION METHODS ---

    updateMapBeliefs(tiles) {
        if (!Array.isArray(tiles)) return;
        tiles.forEach(tile => {
            // Type 2 is a red delivery zone 
            if (tile.type === 2 || tile.type === '2') {
                this.beliefs.deliveryZones.add(`${tile.x},${tile.y}`);
            }
        });
    }

    updateParcelBeliefs(parcelsArray) {
        this.beliefs.parcels.clear(); // Clear old sight
        this.beliefs.carrying.clear();

        if (!Array.isArray(parcelsArray)) return;

        parcelsArray.forEach(p => {
            if (p.carriedBy === this.beliefs.me.id) {
                // We are carrying this parcel
                this.beliefs.carrying.set(p.id, p);
            } else if (!p.carriedBy) {
                // It's on the ground
                this.beliefs.parcels.set(p.id, p);
            }
        });
    }

    // --- DELIBERATION & INTENTION LOGIC ---

    async bdiLoop() {
        // If we are currently executing a time-consuming action, wait.
        if (this.isActing) return;

        // Desire/Intention Generation 
        if (this.beliefs.carrying.size > 0 && this.beliefs.deliveryZones.size > 0) {
            // We have a parcel and know where to drop it
            this.currentIntention = 'DELIVER_PARCEL';
        } else if (this.beliefs.parcels.size > 0) {
            // We see a parcel on the ground
            this.currentIntention = 'GET_PARCEL';
        } else {
            // We see nothing, we need to find parcels or delivery zones
            this.currentIntention = 'EXPLORE';
        }

        // Execute the chosen intention
        this.isActing = true;
        try {
            await this.executeIntention();
        } 
        catch (error) {
            console.error("Action failed:", error);
        } 
        finally {
            // Wait 500ms before allowing the next action to prevent server spam/penalties
            setTimeout(() => {
                this.isActing = false; 
            }, 500); 
        }
    }

    // --- ACTION EXECUTION ---

    async executeIntention() {
        
      if (this.beliefs.me.x === undefined || this.beliefs.me.y === undefined) {
            console.log("Waiting for my coordinates from the server...");
            return; 
        }

        const myX = this.beliefs.me.x;
        const myY = this.beliefs.me.y;

        switch (this.currentIntention) {
                
                case 'GET_PARCEL':
                  // ... (finding best parcel logic)
                  if (bestParcel) {
                      if (myX === bestParcel.x && myY === bestParcel.y) {
                          console.log(`Picking up parcel ${bestParcel.id}`);
                          this.client.emit('pick_up'); 
                      } else {
                          await this.moveTowards(bestParcel.x, bestParcel.y);
                      }
                  }
                  break;

                case 'DELIVER_PARCEL':
                  // ... (finding nearest zone logic)
                  if (targetZone) {
                      if (myX === targetZone.x && myY === targetZone.y) {
                          console.log("Putting down parcel in delivery zone!");
                          this.client.emit('put_down'); 
                      } else {
                          await this.moveTowards(targetZone.x, targetZone.y);
                      }
                  }
                  break;

                case 'EXPLORE':
                // Using the exact strings from the project description
                const directions = ['a', 'w', 's', 'd', 'q', 'e']; 
                const randomDir = directions[Math.floor(Math.random() * directions.length)];
                
                console.log(`Exploring: ${randomDir}`);
                this.client.emit(randomDir); // Emitting the string directly
                break;
        }
    }

    // --- HELPER METHODS ---

    getNearestDeliveryZone() {
        if (this.beliefs.deliveryZones.size === 0) return null;
        
        let nearest = null;
        let minDxDySq = Infinity;
        const myX = this.beliefs.me.x;
        const myY = this.beliefs.me.y;

        for (const zoneStr of this.beliefs.deliveryZones) {
            const [zx, zy] = zoneStr.split(',').map(Number);
            const distSq = (myX - zx) ** 2 + (myY - zy) ** 2;
            if (distSq < minDxDySq) {
                minDxDySq = distSq;
                nearest = { x: zx, y: zy };
            }
        }
        return nearest;
    }

    // Greedy move
    async moveTowards(tx, ty) {
        const myX = this.beliefs.me.x;
        const myY = this.beliefs.me.y;
        
        const dx = tx - myX;
        const dy = ty - myY;

        if (Math.abs(dx) > Math.abs(dy)) {
            if (dx > 0) this.client.emit('move_right'); 
            else this.client.emit('move_left');
        } else {
            if (dy > 0) this.client.emit('move_up'); 
            else this.client.emit('move_down');
        }
    }
}

// Instantiate and start
const agent = new BDIAgent();
agent.start();