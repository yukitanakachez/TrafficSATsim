import { CONFIG, OPP } from './config.js';

let VEH_ID = 0;

// kinds: 'car' (human IDM driver), 'av' (schedule + live ETA), 'ev' (emergency).
export class Vehicle {
  constructor(kind, route, now, spec) {
    this.id = VEH_ID++;
    this.kind = kind;
    this.route = route;
    this.idx = 0;
    this.on = 'link'; // 'link' | 'box'
    this.link = route[0];
    this.s = 0;
    this.v = 7;
    this.len = kind === 'ev' ? CONFIG.veh.evLen : CONFIG.veh.carLen;
    this.wait = 0;        // current standstill streak
    this.totalWait = 0;   // accumulated over the whole trip
    this.spawnT = now;
    this.done = false;
    this.conn = null; this.sBox = 0;
    this.speedFactor = kind === 'car' ? spec.speedFactor : 1;
    this.hue = spec.hue;
    this.link.vehicles.push(this);
    if (kind === 'av') {
      this.dest = route[route.length - 1].to;
      const dist = route.reduce((a, l) => a + l.length, 0);
      const ideal = dist / CONFIG.speeds.clear + (route.length - 1) * 11;
      this.scheduled = now + ideal * CONFIG.av.scheduleSlack;
      this.eta = now + ideal;
      this.lateness = 0;
      this.lastSnapshot = now;
      this.snapshots = [];
    }
  }

  idmParams(env) {
    const p = this.kind === 'car' ? CONFIG.idm : CONFIG.idmAV;
    return {
      a: p.a * env.accelMul, b: p.b, T: p.T * env.gapMul, s0: p.s0, delta: p.delta,
      v0: Math.max(2, env.vmax * this.speedFactor * (this.kind === 'ev' ? CONFIG.speeds.evBoost : 1)),
    };
  }

  // Intelligent Driver Model acceleration toward a (possibly virtual) leader.
  accelFor(gap, dv, p) {
    if (gap < 0.1) gap = 0.1;
    const sStar = p.s0 + Math.max(0, this.v * p.T + (this.v * dv) / (2 * Math.sqrt(p.a * p.b)));
    return p.a * (1 - Math.pow(this.v / p.v0, p.delta) - (sStar / gap) * (sStar / gap));
  }

  canEnterBox(net) {
    const node = this.link.to;
    if (node.type === 'edge') return true;
    const next = this.route[this.idx + 1];
    if (!next) return true;
    if (!node.signal.isGreen(this.link.approachArm)) return false;
    if (next.entrySpace() < this.len + 2.5) return false; // downstream spillback
    const conn = net.connector(this.link, next);
    if (conn.turn === 3) { // left turn yields to oncoming through traffic
      const oncoming = node.incoming[OPP(this.link.approachArm)];
      if (oncoming) {
        for (const o of oncoming.vehicles) {
          if (o !== this && oncoming.length - o.s < 32 && o.v > 2) return false;
        }
      }
    }
    return true;
  }

  step(dt, net, env) {
    if (this.on === 'link') {
      const arr = this.link.vehicles;
      const i = arr.indexOf(this);
      const leader = i > 0 ? arr[i - 1] : null;
      const p = this.idmParams(env);
      let acc = leader
        ? this.accelFor(leader.s - leader.len - this.s, this.v - leader.v, p)
        : p.a * (1 - Math.pow(this.v / p.v0, p.delta));
      // Near the stop line, check whether we may enter the intersection box;
      // if not, brake toward a virtual standing obstacle at the line.
      const nearEnd = this.s > this.link.length - 45;
      const allowed = nearEnd ? this.canEnterBox(net) : null;
      if (allowed === false) {
        acc = Math.min(acc, this.accelFor(this.link.length - this.s, this.v, p));
      }
      this.v = Math.max(0, this.v + acc * dt);
      this.s += this.v * dt;
      if (this.s >= this.link.length) {
        if (this.link.to.type === 'edge') { this.removeFromLink(); this.done = true; }
        else if (allowed) {
          this.removeFromLink();
          this.conn = net.connector(this.link, this.route[this.idx + 1]);
          this.on = 'box';
          this.sBox = this.s - this.link.length;
        } else {
          this.s = this.link.length - 0.15;
          this.v = 0;
        }
      }
    } else {
      const p = this.idmParams(env);
      const vTurn = p.v0 * (this.conn.turn === 0 ? 1 : this.conn.turn === 1 ? 0.55 : 0.45);
      this.v = Math.min(this.v + p.a * dt, Math.max(3, vTurn));
      this.sBox += this.v * dt;
      if (this.sBox >= this.conn.length) {
        this.idx++;
        this.link = this.route[this.idx];
        this.s = Math.min(this.sBox - this.conn.length, 2);
        this.on = 'link';
        this.conn = null;
        this.link.vehicles.push(this); // enters at s≈0, naturally last in FIFO
      }
    }
    if (this.v < 0.3) { this.wait += dt; this.totalWait += dt; }
    else this.wait = 0;
  }

  removeFromLink() {
    const i = this.link.vehicles.indexOf(this);
    if (i >= 0) this.link.vehicles.splice(i, 1);
  }

  pos() {
    if (this.on === 'box') {
      const p = this.conn.posAt(this.sBox);
      const q = this.conn.posAt(Math.min(this.conn.length, this.sBox + 1.5));
      const hx = q.x - p.x, hz = q.z - p.z;
      const h = Math.hypot(hx, hz) || 1;
      return { x: p.x, z: p.z, hx: hx / h, hz: hz / h };
    }
    const p = this.link.posAt(Math.min(this.s, this.link.length));
    return { x: p.x, z: p.z, hx: this.link.ux, hz: this.link.uz };
  }

  // Remaining distance plus congestion features for the ETA model.
  remaining() {
    let dist = this.on === 'box' ? this.conn.length - this.sBox : this.link.length - this.s;
    let queued = 0, signals = 0;
    if (this.on === 'link') {
      if (this.link.to.type === 'int') signals++;
      const i = this.link.vehicles.indexOf(this);
      if (i > 0) queued += i;
    }
    for (let i = this.idx + 1; i < this.route.length; i++) {
      dist += this.route[i].length;
      queued += this.route[i].vehicles.length;
      if (this.route[i].to.type === 'int') signals++;
    }
    return { dist, queued, signals };
  }

  updateEta(now, env, etaModel, ctx) {
    const r = this.remaining();
    const phys = r.dist / env.vmax + r.queued * 2.2 + r.signals * 7;
    const f = etaModel.features(r.dist, r.queued, r.signals, env.code, ctx.spawnMul, ctx.avgWait);
    const remainingSec = etaModel.ready()
      ? 0.45 * phys + 0.55 * etaModel.predict(f)
      : phys;
    this.eta = now + remainingSec;
    this.lateness = this.eta - this.scheduled;
    if (now - this.lastSnapshot >= CONFIG.av.etaSnapshotEvery) {
      this.lastSnapshot = now;
      this.snapshots.push({ f, t: now });
      if (this.snapshots.length > 60) this.snapshots.shift();
    }
  }

  // Indicator color above the AV: on time / slightly late / significantly late.
  latenessBucket() {
    if (this.lateness <= 5) return 'on';
    if (this.lateness <= 30) return 'slight';
    return 'late';
  }
}
