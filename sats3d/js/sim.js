import { CONFIG, WEATHER, TOD, OPP } from './config.js';
import { RNG } from './rng.js';
import { buildNetwork, findRoute } from './network.js';
import { Vehicle } from './vehicles.js';
import { Pedestrian } from './pedestrians.js';
import { SignalController } from './signals.js';
import { EtaModel } from './ml/eta.js';

// One full simulation world. The comparison twin is just a second Simulation
// with the same seed, the same shared params object, and mode 'fixed' —
// because every random draw happens in the same order regardless of what the
// signals do (specs are pre-rolled, blocked spawns queue instead of re-rolling),
// both worlds receive identical traffic.
export class Simulation {
  constructor(opts) {
    this.label = opts.label || 'SATS';
    this.mode = opts.mode || 'sats'; // 'fixed' | 'sats' | 'rl'
    this.seed = opts.seed;
    this.agent = opts.agent || null;
    this.params = opts.params;
    this.net = buildNetwork(CONFIG);
    for (const n of this.net.intersections) n.signal = new SignalController(n);
    this.rngSpawn = new RNG(this.seed);
    this.time = 0;
    this.tickAcc = 0;
    this.spawnAcc = 0;
    this.vehicles = [];
    this.peds = [];
    this.pendingSpawns = [];
    this.etaModel = new EtaModel();
    this.stats = { cleared: 0, tripWaitSum: 0, avDone: 0, avLateSum: 0, avEarly: 0, avOn: 0, avLate: 0 };
    this.packets = [];      // mesh-sync events for the visual overlay
    this.packetStamp = 0;
    this.rlPending = new Map(); // node.id → {s, a, rSum, n}
    this.measureCache = new Map();
  }

  env() { return WEATHER[this.params.weatherKey]; }
  tod() { return TOD[this.params.todKey]; }

  // Advance by simDt simulated seconds (speed multiplier × real dt).
  advance(simDt) {
    let remaining = simDt;
    while (remaining > 1e-9) {
      const dt = Math.min(CONFIG.sim.dt, remaining);
      this.physics(dt);
      remaining -= dt;
      this.tickAcc += dt;
      if (this.tickAcc >= 1) { this.tickAcc -= 1; this.second(); }
    }
  }

  physics(dt) {
    const env = this.env();
    for (const v of this.vehicles) v.step(dt, this.net, env);
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      if (!v.done) continue;
      this.vehicles.splice(i, 1);
      this.stats.cleared++;
      this.stats.tripWaitSum += v.totalWait;
      if (v.kind === 'av') this.completeAv(v);
    }
    for (const p of this.peds) p.step(dt);
    for (let i = this.peds.length - 1; i >= 0; i--) {
      if (this.peds[i].doneFor) this.peds.splice(i, 1);
    }
    this.time += dt;
  }

  completeAv(v) {
    const late = this.time - v.scheduled;
    this.stats.avDone++;
    this.stats.avLateSum += late;
    if (late < -5) this.stats.avEarly++;
    else if (late <= 10) this.stats.avOn++;
    else this.stats.avLate++;
    // Every snapshot becomes a supervised pair: features → actual remaining time.
    for (const snap of v.snapshots) this.etaModel.train(snap.f, this.time - snap.t);
  }

  // Runs once per simulated second: spawning, ETA updates, mesh, signal decisions.
  second() {
    this.measureCache.clear();
    this.spawnVehicles();
    this.spawnPeds();
    const env = this.env();
    const avgWait = this.avgCurrentWait();
    const spawnMul = this.tod().spawnMul;
    for (const v of this.vehicles) {
      if (v.kind === 'av') v.updateEta(this.time, env, this.etaModel, { spawnMul, avgWait });
    }
    this.emergencyPreempt();
    this.meshExchange();
    const ctx = {
      mode: this.mode,
      measure: (n) => this.measure(n),
      score: { ...CONFIG.score, latenessWeight: this.params.latenessWeight },
      tod: this.tod(),
      rlDecide: (sig, m) => this.rlDecide(sig, m),
    };
    for (const n of this.net.intersections) n.signal.update(ctx);
    if (this.mode === 'rl' && this.agent) this.rlAccumulate();
  }

  spawnVehicles() {
    const rate = this.params.spawnRate * this.tod().spawnMul;
    this.spawnAcc += rate / 60;
    const edges = this.net.edgeNodes;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      const r = this.rngSpawn;
      // Fixed number of draws per spec keeps twin RNG streams aligned.
      const entry = r.int(0, edges.length - 1);
      const exit = (entry + 1 + r.int(0, edges.length - 2)) % edges.length;
      const kind = r.chance(this.params.avRatio) ? 'av' : 'car';
      this.pendingSpawns.push({
        entry, exit, kind,
        speedFactor: 1 + (r.next() * 2 - 1) * CONFIG.veh.humanVar,
        hue: r.next(),
        routeSeed: r.int(1, 1e9),
        route: null,
      });
    }
    for (let i = 0; i < this.pendingSpawns.length; i++) {
      const spec = this.pendingSpawns[i];
      if (!spec.route) {
        spec.route = findRoute(this.net, edges[spec.entry], edges[spec.exit], new RNG(spec.routeSeed));
      }
      if (spec.route && spec.route[0].entrySpace() > CONFIG.veh.carLen + 3) {
        this.vehicles.push(new Vehicle(spec.kind, spec.route, this.time, spec));
        this.pendingSpawns.splice(i, 1); i--;
      }
    }
  }

  spawnPeds() {
    const tod = this.tod();
    const p = tod.pedMul / CONFIG.spawn.pedMeanGap;
    for (const n of this.net.intersections) {
      if (!this.rngSpawn.chance(p)) continue;
      const arm = this.rngSpawn.int(0, 3);
      const weights = CONFIG.ped.mix.slice();
      weights[2] += tod.childBoost;
      const typeIdx = this.rngSpawn.pickWeighted(weights);
      const fromA = this.rngSpawn.chance(0.5);
      this.peds.push(new Pedestrian(n, arm, typeIdx, fromA));
    }
  }

  // UI-triggered spawns take explicit args so main can feed the twin identically.
  spawnEV(entryIdx, exitIdx, routeSeed) {
    const edges = this.net.edgeNodes;
    const route = findRoute(this.net, edges[entryIdx], edges[exitIdx], new RNG(routeSeed));
    if (!route) return;
    this.vehicles.push(new Vehicle('ev', route, this.time, { speedFactor: 1, hue: 0 }));
  }

  addPedestrian(nodeId, arm, typeIdx, fromA) {
    const node = this.net.intersections.find(n => n.id === nodeId);
    if (node) this.peds.push(new Pedestrian(node, arm, typeIdx, fromA));
  }

  // Approaching emergency vehicles preempt the next signals along their route.
  emergencyPreempt() {
    for (const v of this.vehicles) {
      if (v.kind !== 'ev' || v.done) continue;
      let d = v.on === 'box' ? -v.sBox : -v.s;
      for (let i = v.idx; i < v.route.length && d < 140; i++) {
        const l = v.route[i];
        d += l.length;
        if (d > 0 && l.to.type === 'int') l.to.signal.preempt(l.approachArm, 5);
      }
    }
  }

  // Each intersection shares state with its neighbors every tick. The scorer
  // reads neighbor links directly; this records the exchange for the overlay.
  meshExchange() {
    this.packets.length = 0;
    this.packetStamp++;
    for (const n of this.net.intersections) {
      for (let arm = 0; arm < 4; arm++) {
        const nb = n.neighbors[arm];
        if (!nb) continue;
        this.packets.push({ fx: n.x, fz: n.z, tx: nb.x, tz: nb.z });
        nb.signal.rxPulse = 2;
      }
    }
  }

  // Per-arm measurements feeding both the heuristic scorer and the RL state.
  measure(node) {
    let m = this.measureCache.get(node.id);
    if (m) return m;
    const arms = [];
    for (let arm = 0; arm < 4; arm++) {
      const inL = node.incoming[arm];
      const a = { queue: 0, headWait: 0, lateness: 0, platoon: 0, downstreamJam: 0 };
      if (inL) {
        for (const v of inL.vehicles) {
          const toStop = inL.length - v.s;
          if (toStop < 70 && v.v < 1.5) {
            a.queue++;
            if (v.wait > a.headWait) a.headWait = v.wait;
          }
          if (v.kind === 'av' && v.lateness > 0 && toStop < 90) {
            a.lateness += Math.min(120, v.lateness) / 10;
          }
          if (inL.from.type === 'int' && v.v > 4 && toStop < 60) a.platoon++;
        }
        const outL = node.outgoing[OPP(arm)];
        if (outL) {
          const occ = outL.occupancy();
          if (occ > 0.65) a.downstreamJam = occ - 0.65;
        }
      }
      arms.push(a);
    }
    let pedWeight = 0, pedMaxWait = 0, pedMidCrossing = false;
    for (const p of this.peds) {
      if (p.node !== node) continue;
      if (p.state === 'wait') {
        pedWeight += p.vulnerable ? CONFIG.score.vulnerableMul : 1;
        if (p.waitT > pedMaxWait) pedMaxWait = p.waitT;
      }
      if (p.midCrossing) pedMidCrossing = true;
    }
    m = { arms, pedWeight, pedMaxWait, pedMidCrossing };
    this.measureCache.set(node.id, m);
    return m;
  }

  // ---- RL plumbing (shared agent across intersections) ----
  rlState(sig, m) {
    const s = [];
    for (let arm = 0; arm < 4; arm++) {
      const a = m.arms[arm];
      s.push(
        Math.min(1, a.queue / 10),
        Math.min(1, a.headWait / 90),
        Math.min(1, a.lateness / 8),
        Math.min(1, a.downstreamJam * 3),
      );
    }
    s.push(Math.min(1, m.pedWeight / 6), Math.min(1, m.pedMaxWait / 90));
    s.push(sig.phase === 0 ? 1 : 0, sig.phase === 1 ? 1 : 0, sig.phase === 2 ? 1 : 0);
    s.push(Math.min(1, sig.tInPhase / 60));
    s.push(this.env().code / 2, this.tod().night ? 1 : 0);
    return s; // 24 dims
  }

  rlDecide(sig, m) {
    const state = this.rlState(sig, m);
    const pending = this.rlPending.get(sig.node.id);
    if (pending && pending.n > 0) {
      this.agent.remember(pending.s, pending.a, pending.rSum / pending.n, state);
    }
    const a = this.agent.act(state);
    this.rlPending.set(sig.node.id, { s: state, a, rSum: 0, n: 0 });
    return a;
  }

  // Reward each tick: negative pressure (queues, lateness, ped waiting).
  rlAccumulate() {
    for (const n of this.net.intersections) {
      const pending = this.rlPending.get(n.id);
      if (!pending) continue;
      const m = this.measure(n);
      let q = 0, late = 0;
      for (const a of m.arms) { q += a.queue; late += a.lateness; }
      const r = Math.max(-6, -(q / 8) - (late / 12) - (m.pedWeight / 6) - (m.pedMaxWait / 60));
      pending.rSum += r;
      pending.n++;
    }
  }

  avgCurrentWait() {
    let sum = 0, n = 0;
    for (const v of this.vehicles) if (v.wait > 0.5) { sum += v.wait; n++; }
    return n ? sum / n : 0;
  }

  snapshot() {
    let longest = null, waitSum = 0, waitN = 0;
    let avEarly = 0, avOn = 0, avSlight = 0, avLate = 0;
    for (const v of this.vehicles) {
      if (v.wait > 0.5) {
        waitSum += v.wait; waitN++;
        if (!longest || v.wait > longest.wait) longest = v;
      }
      if (v.kind === 'av') {
        if (v.lateness < -5) avEarly++;
        else if (v.lateness <= 5) avOn++;
        else if (v.lateness <= 30) avSlight++;
        else avLate++;
      }
    }
    const s = this.stats;
    return {
      label: this.label, mode: this.mode, time: this.time,
      active: this.vehicles.length, peds: this.peds.length,
      avgCurrentWait: waitN ? waitSum / waitN : 0,
      longestWait: longest ? longest.wait : 0,
      longestId: longest ? longest.id : -1,
      cleared: s.cleared,
      avgTripWait: s.cleared ? s.tripWaitSum / s.cleared : 0,
      avEarly, avOn, avSlight, avLate,
      avgExitLateness: s.avDone ? s.avLateSum / s.avDone : 0,
      avDone: s.avDone,
      phases: this.net.intersections.map(n => ({ phase: n.signal.phase, clearing: n.signal.clearing })),
      eta: { n: this.etaModel.n, mae: this.etaModel.maeEma },
    };
  }
}
