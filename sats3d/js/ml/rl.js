import { MLP } from './nn.js';

// DQN-style agent for signal control: epsilon-greedy exploration, experience
// replay, and a periodically-synced target network. One agent is SHARED by
// all nine intersections — the task is homogeneous, so pooling their
// experience multiplies training data ×9 and makes learning visibly faster.
// Learned weights persist to localStorage across page reloads.
export class QAgent {
  constructor(stateDim, nActions, cfg, rng) {
    this.stateDim = stateDim; this.nActions = nActions;
    this.cfg = cfg; this.rng = rng;
    const sizes = [stateDim, ...cfg.hidden, nActions];
    this.net = new MLP(sizes);
    this.target = new MLP(sizes);
    this.target.copyFrom(this.net);
    this.buffer = []; this.bufHead = 0;
    this.steps = 0; this.trainSteps = 0;
    this.lossEma = 0; this.rewardEma = 0;
    this.rewardHistory = [];
  }

  epsilon() {
    const { epsStart, epsEnd, epsDecaySteps } = this.cfg;
    const t = Math.min(1, this.steps / epsDecaySteps);
    return epsStart + (epsEnd - epsStart) * t;
  }

  act(state) {
    this.steps++;
    if (this.rng.chance(this.epsilon())) return this.rng.int(0, this.nActions - 1);
    const q = this.net.forward(state);
    let best = 0;
    for (let a = 1; a < this.nActions; a++) if (q[a] > q[best]) best = a;
    return best;
  }

  remember(s, a, r, s2) {
    const item = { s: Float64Array.from(s), a, r, s2: Float64Array.from(s2) };
    if (this.buffer.length < this.cfg.buffer) this.buffer.push(item);
    else { this.buffer[this.bufHead] = item; this.bufHead = (this.bufHead + 1) % this.cfg.buffer; }
    this.rewardEma = this.rewardEma * 0.99 + r * 0.01;
    this.rewardHistory.push(r);
    if (this.rewardHistory.length > 240) this.rewardHistory.shift();
    this.train();
  }

  train() {
    const { batch, gamma, lr, targetSync } = this.cfg;
    if (this.buffer.length < batch * 2) return;
    for (let k = 0; k < batch; k++) {
      const e = this.buffer[Math.floor(this.rng.next() * this.buffer.length)];
      const q2 = this.target.forward(e.s2);
      let m = q2[0];
      for (let a = 1; a < this.nActions; a++) if (q2[a] > m) m = q2[a];
      const loss = this.net.trainQ(e.s, e.a, e.r + gamma * m, lr);
      this.lossEma = this.lossEma * 0.995 + loss * 0.005;
    }
    this.trainSteps++;
    if (this.trainSteps % targetSync === 0) this.target.copyFrom(this.net);
  }

  save() {
    try {
      localStorage.setItem(this.cfg.storageKey, JSON.stringify({ net: this.net.toJSON(), steps: this.steps }));
    } catch (e) { /* storage unavailable — learning still works in-memory */ }
  }

  load() {
    try {
      const j = JSON.parse(localStorage.getItem(this.cfg.storageKey) || 'null');
      const want = [this.stateDim, ...this.cfg.hidden, this.nActions].join();
      if (j && j.net.sizes.join() === want) {
        this.net = MLP.fromJSON(j.net);
        this.target.copyFrom(this.net);
        this.steps = j.steps || 0;
        return true;
      }
    } catch (e) { /* ignore corrupt store */ }
    return false;
  }

  reset() {
    const sizes = [this.stateDim, ...this.cfg.hidden, this.nActions];
    this.net = new MLP(sizes);
    this.target = new MLP(sizes);
    this.target.copyFrom(this.net);
    this.buffer = []; this.bufHead = 0;
    this.steps = 0; this.trainSteps = 0;
    this.lossEma = 0; this.rewardEma = 0; this.rewardHistory = [];
    try { localStorage.removeItem(this.cfg.storageKey); } catch (e) {}
  }
}
