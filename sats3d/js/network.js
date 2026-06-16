import { CONFIG, DIRS, OPP } from './config.js';

let NODE_ID = 0, LINK_ID = 0;

export class Node {
  constructor(type, x, z, gx = -1, gy = -1) {
    this.id = NODE_ID++;
    this.type = type; // 'int' | 'edge'
    this.x = x; this.z = z; this.gx = gx; this.gy = gy;
    this.boxHalf = type === 'int' ? CONFIG.grid.boxHalf : 0;
    this.incoming = [null, null, null, null]; // by arrival arm
    this.outgoing = [null, null, null, null]; // by travel direction
    this.neighbors = [null, null, null, null]; // adjacent intersections by arm
    this.signal = null;
    this.crosswalks = null;
  }
}

// A directed single-lane segment between two nodes. Geometry runs box-edge to
// box-edge, offset to the right of travel (right-hand traffic). Vehicles are
// kept sorted front-first (largest s first) — no overtaking, so FIFO holds.
export class Link {
  constructor(from, to, dir) {
    this.id = LINK_ID++;
    this.from = from; this.to = to; this.dir = dir;
    this.approachArm = OPP(dir); // which arm of `to` this link arrives on
    const d = DIRS[dir];
    const rx = -d.dz, rz = d.dx; // unit right of travel
    const off = CONFIG.road.laneOffset;
    this.ax = from.x + d.dx * from.boxHalf + rx * off;
    this.az = from.z + d.dz * from.boxHalf + rz * off;
    this.bx = to.x - d.dx * to.boxHalf + rx * off;
    this.bz = to.z - d.dz * to.boxHalf + rz * off;
    this.length = Math.hypot(this.bx - this.ax, this.bz - this.az);
    this.ux = (this.bx - this.ax) / this.length;
    this.uz = (this.bz - this.az) / this.length;
    this.vehicles = [];
  }
  posAt(s) { return { x: this.ax + this.ux * s, z: this.az + this.uz * s }; }
  entrySpace() {
    const last = this.vehicles[this.vehicles.length - 1];
    return last ? last.s - last.len : this.length;
  }
  occupancy() {
    let used = 0;
    for (const v of this.vehicles) used += v.len + 2;
    return Math.min(1, used / this.length);
  }
}

function bezier(p0, p1, p2, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    z: u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z,
  };
}

// Quadratic-bezier turn path across the intersection box from the end of one
// link to the start of the next. turn: 0=straight, 1=right, 3=left.
export function makeConnector(inLink, outLink) {
  const p0 = { x: inLink.bx, z: inLink.bz };
  const p2 = { x: outLink.ax, z: outLink.az };
  const t = DIRS[inLink.dir];
  const straight = inLink.dir === outLink.dir;
  const p1 = straight
    ? { x: (p0.x + p2.x) / 2, z: (p0.z + p2.z) / 2 }
    : { x: t.dx !== 0 ? p2.x : p0.x, z: t.dz !== 0 ? p2.z : p0.z };
  let length = 0, prev = p0;
  for (let i = 1; i <= 8; i++) {
    const p = bezier(p0, p1, p2, i / 8);
    length += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
  }
  const turn = (outLink.dir - inLink.dir + 4) % 4;
  return { length, turn, posAt: (s) => bezier(p0, p1, p2, Math.min(1, Math.max(0, s / length))) };
}

export function buildNetwork(cfg) {
  NODE_ID = 0; LINK_ID = 0; // deterministic ids so renderer refs survive sim restarts
  const { nx, ny, spacing, stubLen } = cfg.grid;
  const nodes = [], links = [], intersections = [], edgeNodes = [];
  const grid = [];
  const cx = (nx - 1) / 2, cy = (ny - 1) / 2;
  for (let gy = 0; gy < ny; gy++) {
    grid.push([]);
    for (let gx = 0; gx < nx; gx++) {
      const n = new Node('int', (gx - cx) * spacing, (gy - cy) * spacing, gx, gy);
      grid[gy].push(n); nodes.push(n); intersections.push(n);
    }
  }
  const connect = (a, b, dir) => {
    const l1 = new Link(a, b, dir), l2 = new Link(b, a, OPP(dir));
    links.push(l1, l2);
    a.outgoing[dir] = l1; b.incoming[l1.approachArm] = l1;
    b.outgoing[OPP(dir)] = l2; a.incoming[l2.approachArm] = l2;
  };
  for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++) {
    if (gx + 1 < nx) {
      connect(grid[gy][gx], grid[gy][gx + 1], 1);
      grid[gy][gx].neighbors[1] = grid[gy][gx + 1];
      grid[gy][gx + 1].neighbors[3] = grid[gy][gx];
    }
    if (gy + 1 < ny) {
      connect(grid[gy][gx], grid[gy + 1][gx], 2);
      grid[gy][gx].neighbors[2] = grid[gy + 1][gx];
      grid[gy + 1][gx].neighbors[0] = grid[gy][gx];
    }
  }
  for (const n of intersections) {
    for (let arm = 0; arm < 4; arm++) {
      if (n.neighbors[arm]) continue;
      const d = DIRS[arm];
      const e = new Node('edge', n.x + d.dx * stubLen, n.z + d.dz * stubLen);
      nodes.push(e); edgeNodes.push(e);
      connect(n, e, arm);
    }
    n.crosswalks = [];
    for (let arm = 0; arm < 4; arm++) {
      const d = DIRS[arm];
      const rx = -d.dz, rz = d.dx;
      const half = CONFIG.road.width / 2;
      const px = n.x + d.dx * (n.boxHalf + 1.6);
      const pz = n.z + d.dz * (n.boxHalf + 1.6);
      n.crosswalks.push({
        arm,
        ax: px + rx * half, az: pz + rz * half,
        bx: px - rx * half, bz: pz - rz * half,
        len: CONFIG.road.width,
      });
    }
  }
  // Precompute turn connectors for every legal in→out pair (no U-turns).
  const connectors = new Map();
  for (const n of intersections) {
    for (let arm = 0; arm < 4; arm++) {
      const inL = n.incoming[arm];
      if (!inL) continue;
      for (let o = 0; o < 4; o++) {
        if (o === arm) continue;
        const outL = n.outgoing[o];
        if (outL) connectors.set(inL.id + ':' + outL.id, makeConnector(inL, outL));
      }
    }
  }
  return {
    nodes, links, intersections, edgeNodes, grid,
    connector: (a, b) => connectors.get(a.id + ':' + b.id),
  };
}

// BFS shortest route (by hops) from an entry edge node to an exit edge node,
// randomized tie-breaking for route variety. Returns an array of links.
export function findRoute(net, entry, exit, rng) {
  const visited = new Set([entry.id]);
  const queue = [{ node: entry, path: [] }];
  while (queue.length) {
    const { node, path } = queue.shift();
    if (node === exit) return path;
    const out = node.outgoing.filter(l => l).sort(() => rng.next() - 0.5);
    for (const l of out) {
      if (path.length && l.dir === OPP(path[path.length - 1].dir)) continue; // no U-turns
      if (visited.has(l.to.id)) continue;
      visited.add(l.to.id);
      queue.push({ node: l.to, path: [...path, l] });
    }
  }
  return null;
}
