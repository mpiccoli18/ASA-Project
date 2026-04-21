// Priority-based intention management. One "current" intention is active;
// others queue. On sensing updates, re-score and reorder — but only preempt
// the current intention if a challenger is better by a meaningful margin
// (to avoid ping-ponging when scores are close).

export class IntentionQueue {
  constructor({ preemptMargin = 2 } = {}) {
    this.current = null;          // { id, type, target, plan, planCursor, score }
    this.candidates = [];          // scored candidate intentions, sorted desc by score
    this.preemptMargin = preemptMargin;
  }

  /**
   * Replace the candidate list from a fresh round of option generation.
   * Returns true if the current intention should be preempted in favor of a better candidate.
   */
  reviseCandidates(candidates) {
    this.candidates = [...candidates].sort((a, b) => b.score - a.score);

    if (!this.current) return this.candidates.length > 0;

    const best = this.candidates[0];
    if (!best) return false;

    // Preempt only if the best candidate substantially beats the current score
    return best.score > this.current.score + this.preemptMargin;
  }

  /** Advance: either continue current, or adopt the top candidate if current is done/invalid. */
  next() {
    if (this.current && this.current.planCursor < this.current.plan.length) {
      return this.current;
    }
    this.current = this.candidates.shift() ?? null;
    return this.current;
  }

  /** Drop the current intention (e.g., plan failed or goal invalidated). */
  drop() {
    this.current = null;
  }

  /** Mark the current plan step done. */
  advanceCursor() {
    if (this.current) this.current.planCursor += 1;
  }
}
