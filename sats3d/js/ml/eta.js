// Online linear ETA model trained by SGD on completed AV trips. AVs snapshot
// their features every few seconds; when they exit, each snapshot becomes a
// (features → actual remaining time) training pair. The model corrects the
// naive physics estimate using what actually happened to earlier vehicles.
export class EtaModel {
  constructor() {
    this.w = new Float64Array(7); // 6 features + bias
    this.n = 0;
    this.maeEma = 0;
    this.lr = 0.02;
  }
  features(remDist, queuedAhead, signalsAhead, weatherCode, spawnMul, avgNetWait) {
    return [remDist / 100, queuedAhead / 10, signalsAhead / 5, weatherCode / 2, spawnMul / 2, avgNetWait / 30];
  }
  predict(f) {
    let y = this.w[6];
    for (let i = 0; i < 6; i++) y += this.w[i] * f[i];
    return Math.max(0, y * 60); // internally scaled to minutes
  }
  train(f, actualSec) {
    const pred = this.predict(f);
    const g = Math.max(-2, Math.min(2, (pred - actualSec) / 60));
    for (let i = 0; i < 6; i++) this.w[i] -= this.lr * g * f[i];
    this.w[6] -= this.lr * g;
    this.n++;
    const ae = Math.abs(pred - actualSec);
    this.maeEma = this.maeEma === 0 ? ae : this.maeEma * 0.97 + ae * 0.03;
  }
  ready() { return this.n >= 40; }
}
