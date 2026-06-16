import * as THREE from 'three';
import { CONFIG, DIRS, OPP } from '../config.js';
import { RNG } from '../rng.js';

// Builds the static world once. Returns refs the per-frame layer needs:
// signal-lamp materials per intersection arm, antenna pulse materials,
// clickable intersection slabs, and environment handles (sun, fog, lamps).
export function buildScene(net, container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc7e8);
  scene.fog = new THREE.FogExp2(0x9fc7e8, 0.0008);

  const camera = new THREE.PerspectiveCamera(
    70, container.clientWidth / container.clientHeight, 0.1, 1500);

  const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x44503c, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
  sun.position.set(140, 200, 90);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -220; sc.right = 220; sc.top = 220; sc.bottom = -220; sc.far = 600;
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.MeshLambertMaterial({ color: 0x49583f }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  ground.receiveShadow = true;
  scene.add(ground);

  const roadMat = new THREE.MeshLambertMaterial({ color: 0x3b3b40 });
  const boxMat = new THREE.MeshLambertMaterial({ color: 0x46464b });
  const lineMat = new THREE.MeshBasicMaterial({ color: 0x9b9b55 });
  const zebraMat = new THREE.MeshBasicMaterial({ color: 0xd8d8d8 });
  const W = CONFIG.road.width;

  // Road slabs — one per undirected segment (links come in dir pairs; drawing
  // only dirs 1 and 2 covers each pair exactly once).
  for (const l of net.links) {
    if (l.dir !== 1 && l.dir !== 2) continue;
    const d = DIRS[l.dir];
    const sx = l.from.x + d.dx * l.from.boxHalf, sz = l.from.z + d.dz * l.from.boxHalf;
    const ex = l.to.x - d.dx * l.to.boxHalf, ez = l.to.z - d.dz * l.to.boxHalf;
    const len = Math.hypot(ex - sx, ez - sz);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(
      l.dir === 1 ? len : W, 0.12, l.dir === 1 ? W : len), roadMat);
    slab.position.set((sx + ex) / 2, 0, (sz + ez) / 2);
    slab.receiveShadow = true;
    scene.add(slab);
    const line = new THREE.Mesh(new THREE.BoxGeometry(
      l.dir === 1 ? len - 2 : 0.25, 0.13, l.dir === 1 ? 0.25 : len - 2), lineMat);
    line.position.set((sx + ex) / 2, 0.035, (sz + ez) / 2);
    scene.add(line);
  }

  const pickMeshes = [];
  const signalRefs = {};
  const antennaRefs = {};
  const lampMats = [];

  const mkLamp = (color) => new THREE.MeshStandardMaterial({
    color: 0x222222, emissive: color, emissiveIntensity: 0.05 });

  for (const n of net.intersections) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(16.6, 0.14, 16.6), boxMat);
    slab.position.set(n.x, 0, n.z);
    slab.receiveShadow = true;
    slab.userData.nodeId = n.id;
    scene.add(slab);
    pickMeshes.push(slab);

    // Zebra crosswalk stripes
    for (const cw of n.crosswalks) {
      const d = DIRS[cw.arm];
      for (let k = 0; k <= 6; k++) {
        const t = k / 6;
        const x = cw.ax + (cw.bx - cw.ax) * t;
        const z = cw.az + (cw.bz - cw.az) * t;
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(
          d.dx !== 0 ? 2.4 : 0.6, 0.15, d.dx !== 0 ? 0.6 : 2.4), zebraMat);
        stripe.position.set(x, 0.04, z);
        scene.add(stripe);
      }
    }

    // Signal pole + 3-lamp head + ped lamp per arm
    signalRefs[n.id] = [];
    for (let arm = 0; arm < 4; arm++) {
      const d = DIRS[arm];
      const rx = -d.dz, rz = d.dx;
      const px = n.x + d.dx * (n.boxHalf + 2.4) + rx * (W / 2 + 1.2);
      const pz = n.z + d.dz * (n.boxHalf + 2.4) + rz * (W / 2 + 1.2);
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.14, 5.6, 6),
        new THREE.MeshLambertMaterial({ color: 0x2c2c2c }));
      pole.position.set(px, 2.8, pz);
      pole.castShadow = true;
      scene.add(pole);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.4, 0.5),
        new THREE.MeshLambertMaterial({ color: 0x1c1c1c }));
      head.position.set(px, 4.6, pz);
      scene.add(head);
      const mats = {
        red: mkLamp(0xff2222), yellow: mkLamp(0xffaa00),
        green: mkLamp(0x22ff44), ped: mkLamp(0xffffff),
      };
      const sphere = (mat, y) => {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 10), mat);
        s.position.set(px + (d.dx !== 0 ? 0 : 0.5), y, pz + (d.dx !== 0 ? 0.5 : 0));
        scene.add(s);
      };
      sphere(mats.red, 5.3); sphere(mats.yellow, 4.6); sphere(mats.green, 3.9);
      const pedBox = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), mats.ped);
      pedBox.position.set(px, 2.4, pz);
      scene.add(pedBox);
      signalRefs[n.id][arm] = mats;
    }

    // Mesh antenna — pulses when a packet arrives from a neighbor
    const mastMat = new THREE.MeshStandardMaterial({
      color: 0x333344, emissive: 0x00e5ff, emissiveIntensity: 0.15 });
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 7.5, 6), mastMat);
    mast.position.set(n.x, 3.75, n.z);
    scene.add(mast);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 12), mastMat);
    orb.position.set(n.x, 7.8, n.z);
    scene.add(orb);
    antennaRefs[n.id] = { mat: mastMat, orb };

    // Corner streetlamps (emissive bump at night)
    for (let c = 0; c < 4; c++) {
      const ang = c * Math.PI / 2 + Math.PI / 4;
      const lx = n.x + Math.cos(ang) * (n.boxHalf + 4.5);
      const lz = n.z + Math.sin(ang) * (n.boxHalf + 4.5);
      const lp = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.1, 4.6, 5),
        new THREE.MeshLambertMaterial({ color: 0x3a3a3a }));
      lp.position.set(lx, 2.3, lz);
      scene.add(lp);
      const lm = new THREE.MeshStandardMaterial({
        color: 0x555544, emissive: 0xffe9a8, emissiveIntensity: 0.0 });
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 8), lm);
      bulb.position.set(lx, 4.7, lz);
      scene.add(bulb);
      lampMats.push(lm);
    }
  }

  // Decorative city blocks between the roads (stable seeded layout)
  const brng = new RNG(424242);
  const palette = [0x8a7f72, 0x7a8a93, 0x9a8d7c, 0x6f7d6a, 0x8d8296, 0x77685e];
  const { nx, ny, spacing } = CONFIG.grid;
  const cxg = (nx - 1) / 2, cyg = (ny - 1) / 2;
  for (let gy = -1; gy < ny; gy++) {
    for (let gx = -1; gx < nx; gx++) {
      const bx = (gx - cxg + 0.5) * spacing;
      const bz = (gy - cyg + 0.5) * spacing;
      const nB = brng.int(2, 4);
      for (let i = 0; i < nB; i++) {
        const w = brng.range(10, 22), dep = brng.range(10, 22), h = brng.range(7, 30);
        const ox = brng.range(-18, 18), oz = brng.range(-18, 18);
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, dep),
          new THREE.MeshLambertMaterial({ color: palette[brng.int(0, palette.length - 1)] }));
        m.position.set(bx + ox, h / 2, bz + oz);
        m.castShadow = true; m.receiveShadow = true;
        scene.add(m);
      }
    }
  }

  return { renderer, scene, camera, signalRefs, antennaRefs, pickMeshes, hemi, sun, lampMats };
}
