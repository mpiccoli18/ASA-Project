// Tiny belief store. Wraps a plain object with change notifications so the
// deliberation loop can react when beliefs update (rather than polling).
//
// Design: authoritative writes for fresh sensing data, staleness tracking for
// things that have dropped out of view. The store doesn't decide policy —
// callers decide what to do with stale beliefs.

export class BeliefSet {
  constructor() {
    this.me = null;
    this.map = null;
    this.parcels = new Map();   // id -> { ...parcel, observedAt }
    this.agents = new Map();    // id -> { ...agent, observedAt }
    this.deliveryTiles = [];
    this.spawnerTiles = [];
    this._subscribers = new Set();
  }

  subscribe(fn) {
    this._subscribers.add(fn);
    return () => this._subscribers.delete(fn);
  }

  _notify(change) {
    for (const fn of this._subscribers) fn(change);
  }

  setMe(me) {
    this.me = me;
    this._notify({ kind: 'me' });
  }

  setMap(map) {
    this.map = map;
    this.deliveryTiles = map.tiles.filter(t => t.type === '2');
    this.spawnerTiles = map.tiles.filter(t => t.type === '1');
    this._notify({ kind: 'map' });
  }

  /**
   * Apply a batch of currently-visible parcels. Overwrites existing entries;
   * entries not in the batch are left in place (stale) — caller decides when to prune.
   */
  updateParcels(visible, now = Date.now()) {
    for (const p of visible) {
      this.parcels.set(p.id, { ...p, observedAt: now });
    }
    this._notify({ kind: 'parcels', visibleIds: visible.map(p => p.id) });
  }

  /**
   * Remove parcels that either haven't been seen in `maxAge` ms or have zero reward.
   * Call periodically if you don't want stale beliefs lingering forever.
   */
  pruneParcels({ maxAge = 30_000, now = Date.now() } = {}) {
    for (const [id, p] of this.parcels) {
      if (p.reward <= 0 || now - p.observedAt > maxAge) {
        this.parcels.delete(id);
      }
    }
  }

  updateAgents(visible, now = Date.now()) {
    for (const a of visible) {
      this.agents.set(a.id, { ...a, observedAt: now });
    }
    this._notify({ kind: 'agents', visibleIds: visible.map(a => a.id) });
  }

  /** Parcels the agent is currently carrying. */
  carrying() {
    if (!this.me) return [];
    return [...this.parcels.values()].filter(p => p.carriedBy === this.me.id);
  }

  /** Parcels on the ground, not carried by anyone. */
  freeParcels() {
    return [...this.parcels.values()].filter(p => !p.carriedBy);
  }
}
