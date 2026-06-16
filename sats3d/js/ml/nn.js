// Minimal dense neural network with manual backpropagation — no dependencies.
// tanh hidden layers, linear output. Used as the Q-network for signal control.
export class MLP {
  constructor(sizes) {
    this.sizes = sizes;
    this.W = []; this.b = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const fanIn = sizes[l], fanOut = sizes[l + 1];
      const scale = Math.sqrt(2 / (fanIn + fanOut)); // Xavier init
      const w = new Float64Array(fanIn * fanOut);
      for (let i = 0; i < w.length; i++) w[i] = (Math.random() * 2 - 1) * scale;
      this.W.push(w); this.b.push(new Float64Array(fanOut));
    }
    this.acts = sizes.map(n => new Float64Array(n)); // post-activation cache
  }

  forward(x) {
    this.acts[0].set(x);
    for (let l = 0; l < this.W.length; l++) {
      const inA = this.acts[l], out = this.acts[l + 1];
      const nIn = this.sizes[l], nOut = this.sizes[l + 1];
      const W = this.W[l], b = this.b[l];
      const last = l === this.W.length - 1;
      for (let j = 0; j < nOut; j++) {
        let z = b[j];
        const off = j * nIn;
        for (let i = 0; i < nIn; i++) z += W[off + i] * inA[i];
        out[j] = last ? z : Math.tanh(z);
      }
    }
    return this.acts[this.acts.length - 1];
  }

  // One SGD step pushing output unit `action` toward `target`; other outputs
  // get no gradient (standard DQN single-action TD update).
  trainQ(x, action, target, lr) {
    const out = this.forward(x);
    let err = out[action] - target;
    const absErr = Math.abs(err);
    err = Math.max(-1, Math.min(1, err)); // clipped gradient = Huber-style
    const delta = this.acts.map(a => new Float64Array(a.length));
    delta[this.acts.length - 1][action] = err;
    for (let l = this.W.length - 1; l >= 0; l--) {
      const nIn = this.sizes[l], nOut = this.sizes[l + 1];
      const W = this.W[l], b = this.b[l];
      const inA = this.acts[l], dOut = delta[l + 1], dIn = delta[l];
      for (let j = 0; j < nOut; j++) {
        const dj = dOut[j];
        if (dj === 0) continue;
        const off = j * nIn;
        b[j] -= lr * dj;
        for (let i = 0; i < nIn; i++) {
          if (l > 0) dIn[i] += W[off + i] * dj; // uses pre-update weight
          W[off + i] -= lr * dj * inA[i];
        }
      }
      if (l > 0) {
        const a = this.acts[l];
        for (let i = 0; i < nIn; i++) dIn[i] *= (1 - a[i] * a[i]); // tanh'
      }
    }
    return absErr;
  }

  copyFrom(other) {
    for (let l = 0; l < this.W.length; l++) {
      this.W[l].set(other.W[l]); this.b[l].set(other.b[l]);
    }
  }
  toJSON() {
    return { sizes: this.sizes, W: this.W.map(w => Array.from(w)), b: this.b.map(b => Array.from(b)) };
  }
  static fromJSON(j) {
    const net = new MLP(j.sizes);
    j.W.forEach((w, l) => net.W[l].set(w));
    j.b.forEach((b, l) => net.b[l].set(b));
    return net;
  }
}
