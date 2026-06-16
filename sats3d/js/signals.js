import { CONFIG, phaseOfArm } from './config.js';

// Per-intersection signal controller. Three modes share the same hard rules
// (min/max green, 3-tick all-red clearance, pedestrian crossing-hold):
//   'fixed' — classic timed plan (the comparison baseline)
//   'sats'  — the priority scorer from the SATS plan
//   'rl'    — defers phase choice to the shared Q-learning agent
export class SignalController {
  constructor(node) {
    this.node = node;
    this.cfg = CONFIG.signal;
    this.phase = (node.gx + node.gy) % 2 === 0 ? 0 : 1; // staggered start
    this.tInPhase = 0;
    this.clearing = false; this.clearT = 0;
    this.nextPhase = 0; this.clearedFrom = 0;
    this.tick = 0;
    this.lastServed = [0, 0, 0];
    this.fixedIdx = this.phase; this.fixedT = 0;
    this.preemptArm = -1; this.preemptT = 0;
    this.scores = [0, 0, 0];
    this.rxPulse = 0; // mesh receive indicator, decays each tick
  }

  isGreen(arm) {
    return !this.clearing && this.phase === phaseOfArm(arm);
  }
  pedWalk() { return !this.clearing && this.phase === 2; }
  preempt(arm, ticks) { this.preemptArm = arm; this.preemptT = ticks; }

  update(ctx) {
    this.tick++;
    if (this.rxPulse > 0) this.rxPulse--;
    if (this.preemptT > 0) this.preemptT--; else this.preemptArm = -1;
    const m = ctx.measure(this.node);
    this.scores = this.computeScores(ctx, m);
    if (this.clearing) {
      this.clearT--;
      if (this.clearT <= 0) {
        this.clearing = false;
        this.phase = this.nextPhase;
        this.tInPhase = 0;
      }
      return;
    }
    this.tInPhase++;
    // HARD RULE: the walk phase cannot end while anyone is mid-crossing.
    if (this.phase === 2 && m.pedMidCrossing) return;
    let desired = this.desiredPhase(ctx, m);
    if (this.preemptArm >= 0) desired = phaseOfArm(this.preemptArm);
    if (desired !== this.phase && this.tInPhase >= this.cfg.minGreen) {
      this.beginSwitch(desired);
    } else if (this.tInPhase >= this.cfg.maxGreen) {
      const order = [0, 1, 2]
        .filter(p => p !== this.phase)
        .sort((a, b) => this.scores[b] - this.scores[a]);
      this.beginSwitch(order[0]);
    }
  }

  beginSwitch(next) {
    this.lastServed[this.phase] = this.tick;
    this.clearedFrom = this.phase;
    this.clearing = true;
    this.clearT = this.cfg.clearance; // all-red (shown as yellow) between phases
    this.nextPhase = next;
  }

  desiredPhase(ctx, m) {
    if (ctx.mode === 'fixed') {
      this.fixedT++;
      const plan = this.cfg.fixedPlan;
      if (this.fixedT >= plan[this.fixedIdx].d) {
        this.fixedT = 0;
        this.fixedIdx = (this.fixedIdx + 1) % plan.length;
      }
      return plan[this.fixedIdx].ph;
    }
    if (ctx.mode === 'rl') {
      // Only consult the agent when a switch is actually possible, so its
      // (state, action, reward) transitions describe real decisions.
      if (this.tInPhase < this.cfg.minGreen) return this.phase;
      return ctx.rlDecide(this, m);
    }
    let best = 0;
    for (let p = 1; p < 3; p++) if (this.scores[p] > this.scores[best]) best = p;
    return best;
  }

  // The SATS priority score, per the plan:
  //   queue + wait (exponential past starveT) + AV lateness + ped demand
  //   (vulnerable ×2, already folded into m.pedWeight) + neighbor pressure
  //   (upstream platoon, downstream backpressure) − recency penalty.
  computeScores(ctx, m) {
    const w = ctx.score;
    const tod = ctx.tod;
    const waitTerm = (t) =>
      w.waitW * t + (t > w.starveT ? Math.min(300, Math.exp((t - w.starveT) / 12)) : 0);
    const recency = (p) => {
      const since = this.tick - this.lastServed[p];
      return since < this.cfg.recencyWindow ? w.recencyW * (this.cfg.recencyWindow - since) : 0;
    };
    const scores = [0, 0, 0];
    for (let p = 0; p < 2; p++) {
      let s = 0;
      for (const arm of (p === 0 ? [0, 2] : [1, 3])) {
        const a = m.arms[arm];
        s += w.queueW * tod.queueMul * a.queue;
        s += waitTerm(a.headWait);
        s += w.latenessWeight * a.lateness;
        s += w.upstreamW * a.platoon;
        s -= w.downstreamW * a.downstreamJam;
      }
      s -= recency(p);
      if (this.phase === p && !this.clearing) s += w.holdBonus; // hysteresis
      scores[p] = s;
    }
    let ped = w.pedBase * tod.pedScoreMul * m.pedWeight;
    if (m.pedWeight > 0) ped += waitTerm(m.pedMaxWait);
    ped -= recency(2);
    if (this.phase === 2) ped += w.holdBonus;
    scores[2] = m.pedWeight > 0 || m.pedMidCrossing ? ped : -5;
    return scores;
  }
}
