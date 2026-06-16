import { CONFIG } from './config.js';

let PED_ID = 0;

// Pedestrians wait at a crosswalk corner, cross during the all-walk phase
// (phase 2), and hold that phase open while mid-crossing. Vulnerable types
// (elderly / child / wheelchair) count double in the demand score and are
// slower, so the hold logic matters for them.
export class Pedestrian {
  constructor(node, arm, typeIdx, fromA) {
    this.id = PED_ID++;
    this.node = node;
    this.cw = node.crosswalks[arm];
    this.typeIdx = typeIdx;
    this.type = CONFIG.ped.types[typeIdx];
    this.vulnerable = this.type.weight > 1;
    this.fromA = fromA;
    this.state = 'wait'; // wait → cross → leave
    this.progress = 0;
    this.waitT = 0;
    this.leaveT = 0;
  }

  step(dt) {
    if (this.state === 'wait') {
      this.waitT += dt;
      if (this.node.signal.pedWalk()) this.state = 'cross';
    } else if (this.state === 'cross') {
      this.progress += (this.type.speed * dt) / this.cw.len;
      if (this.progress >= 1) { this.state = 'leave'; this.leaveT = 2.5; }
    } else {
      this.leaveT -= dt;
    }
  }

  get doneFor() { return this.state === 'leave' && this.leaveT <= 0; }
  get midCrossing() { return this.state === 'cross'; }

  pos() {
    let t;
    if (this.state === 'wait') t = this.fromA ? -0.06 : 1.06;
    else if (this.state === 'cross') t = this.fromA ? this.progress : 1 - this.progress;
    else t = this.fromA ? 1.06 : -0.06;
    const { ax, az, bx, bz } = this.cw;
    return { x: ax + (bx - ax) * t, z: az + (bz - az) * t };
  }
}
