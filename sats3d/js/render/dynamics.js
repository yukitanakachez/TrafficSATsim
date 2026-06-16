import * as THREE from 'three';
import { CONFIG, phaseOfArm } from '../config.js';

const BUCKET_COLOR = { on: 0x22ff55, slight: 0xffcc22, late: 0xff3333 };

// Per-frame layer: syncs pooled meshes to sim entities, drives signal lamps,
// mesh-packet pulses, the longest-wait highlight ring, rain, and environment.
export class Visuals {
  constructor(refs) {
    this.refs = refs;
    this.scene = refs.scene;
    this.vehMeshes = new Map();  // vehicle id → group
    this.pedMeshes = new Map();
    this.vehPool = { car: [], av: [], ev: [] };
    this.pedPool = [];
    this.packetSprites = [];
    this.lastPacketStamp = -1;
    this.t = 0;

    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(3.4, 0.22, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xff5533 }));
    this.ring.rotation.x = Math.PI / 2;
    this.ring.visible = false;
    this.scene.add(this.ring);

    // Rain particle pool
    const N = 2600;
    this.rainPos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      this.rainPos[i * 3] = (Math.random() - 0.5) * 320;
      this.rainPos[i * 3 + 1] = Math.random() * 90;
      this.rainPos[i * 3 + 2] = (Math.random() - 0.5) * 320;
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rain = new THREE.Points(rg, new THREE.PointsMaterial({
      color: 0xaac8e8, size: 0.22, transparent: true, opacity: 0.65 }));
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
    this.rainCount = 0;

    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(0,255,255,1)');
    grad.addColorStop(1, 'rgba(0,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    this.packetTex = new THREE.CanvasTexture(cv);
  }

  // ---- mesh factories ----
  makeVehicle(kind) {
    const g = new THREE.Group();
    const len = kind === 'ev' ? CONFIG.veh.evLen : CONFIG.veh.carLen;
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.95, len), bodyMat);
    body.position.y = 0.62; body.castShadow = true;
    g.add(body);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.62, len * 0.45),
      new THREE.MeshLambertMaterial({ color: 0x222a33 }));
    cab.position.set(0, 1.35, -len * 0.05);
    g.add(cab);
    g.userData = { bodyMat, kind };
    if (kind === 'av') {
      const puck = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.25, 10),
        new THREE.MeshLambertMaterial({ color: 0x111418 }));
      puck.position.y = 1.8; g.add(puck);
      const indMat = new THREE.MeshBasicMaterial({ color: 0x22ff55 });
      const ind = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 8), indMat);
      ind.position.y = 2.7; g.add(ind);
      g.userData.indMat = ind.material; g.userData.ind = ind;
    }
    if (kind === 'ev') {
      const barR = new THREE.MeshBasicMaterial({ color: 0xff2222 });
      const barB = new THREE.MeshBasicMaterial({ color: 0x2266ff });
      const b1 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.3, 0.5), barR);
      b1.position.set(-0.45, 1.85, 0); g.add(b1);
      const b2 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.3, 0.5), barB);
      b2.position.set(0.45, 1.85, 0); g.add(b2);
      g.userData.barR = barR; g.userData.barB = barB;
    }
    this.scene.add(g);
    return g;
  }

  makePed() {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 1.25, 8), mat);
    body.position.y = 0.62; body.castShadow = true;
    g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), mat);
    head.position.y = 1.45; g.add(head);
    g.userData = { mat };
    this.scene.add(g);
    return g;
  }

  acquireVehicle(kind) {
    const m = this.vehPool[kind].pop() || this.makeVehicle(kind);
    m.visible = true;
    return m;
  }
  acquirePed() {
    const m = this.pedPool.pop() || this.makePed();
    m.visible = true;
    return m;
  }

  // ---- per-frame sync ----
  sync(sim, opts, dt) {
    this.t += dt;
    const flash = Math.floor(this.t * 5) % 2 === 0;

    const liveV = new Set();
    for (const v of sim.vehicles) {
      liveV.add(v.id);
      let m = this.vehMeshes.get(v.id);
      if (!m) {
        m = this.acquireVehicle(v.kind);
        this.vehMeshes.set(v.id, m);
        if (v.kind === 'car') m.userData.bodyMat.color.setHSL(v.hue, 0.5, 0.48);
        if (v.kind === 'av') m.userData.bodyMat.color.setHex(0x18c7b8);
        if (v.kind === 'ev') m.userData.bodyMat.color.setHex(0xf2f2f2);
      }
      const p = v.pos();
      m.position.set(p.x, 0, p.z);
      m.rotation.y = Math.atan2(p.hx, p.hz);
      if (v.kind === 'av') {
        m.userData.indMat.color.setHex(BUCKET_COLOR[v.latenessBucket()]);
        m.userData.ind.scale.setScalar(v.latenessBucket() === 'late' && flash ? 1.4 : 1);
      }
      if (v.kind === 'ev') {
        m.userData.barR.color.setHex(flash ? 0xff2222 : 0x550000);
        m.userData.barB.color.setHex(flash ? 0x111155 : 0x2266ff);
      }
    }
    for (const [id, m] of this.vehMeshes) {
      if (liveV.has(id)) continue;
      m.visible = false;
      this.vehPool[m.userData.kind].push(m);
      this.vehMeshes.delete(id);
    }

    const liveP = new Set();
    for (const p of sim.peds) {
      liveP.add(p.id);
      let m = this.pedMeshes.get(p.id);
      if (!m) {
        m = this.acquirePed();
        this.pedMeshes.set(p.id, m);
        m.userData.mat.color.setHex(p.type.color);
        m.scale.setScalar(p.type.size);
      }
      const pp = p.pos();
      const bob = p.midCrossing ? Math.sin(this.t * 9 + p.id) * 0.05 : 0;
      m.position.set(pp.x, bob, pp.z);
    }
    for (const [id, m] of this.pedMeshes) {
      if (liveP.has(id)) continue;
      m.visible = false;
      this.pedPool.push(m);
      this.pedMeshes.delete(id);
    }

    // Signal lamps
    for (const n of sim.net.intersections) {
      const sig = n.signal;
      const refs = this.refs.signalRefs[n.id];
      if (!refs) continue;
      for (let arm = 0; arm < 4; arm++) {
        const mats = refs[arm];
        const green = sig.isGreen(arm);
        const yellow = sig.clearing && sig.clearedFrom === phaseOfArm(arm);
        mats.green.emissiveIntensity = green ? 1.6 : 0.05;
        mats.yellow.emissiveIntensity = yellow ? 1.6 : 0.05;
        mats.red.emissiveIntensity = !green && !yellow ? 1.4 : 0.05;
        mats.ped.emissiveIntensity = sig.pedWalk() ? 1.5 : 0.08;
        mats.ped.emissive.setHex(sig.pedWalk() ? 0xffffff : 0xff6600);
      }
      const ant = this.refs.antennaRefs[n.id];
      const pulse = opts.showPackets ? sig.rxPulse : 0;
      ant.mat.emissiveIntensity = 0.15 + pulse * 0.8;
      ant.orb.scale.setScalar(1 + pulse * 0.25);
    }

    // Mesh packets — ingest one batch per sim tick when overlay is on
    if (opts.showPackets && sim.packetStamp !== this.lastPacketStamp) {
      this.lastPacketStamp = sim.packetStamp;
      for (const pk of sim.packets) this.spawnPacket(pk);
    }
    for (let i = this.packetSprites.length - 1; i >= 0; i--) {
      const s = this.packetSprites[i];
      s.userData.t += dt / 0.7;
      if (s.userData.t >= 1 || !opts.showPackets) {
        this.scene.remove(s);
        this.packetSprites.splice(i, 1);
        continue;
      }
      const u = s.userData;
      s.position.set(
        u.fx + (u.tx - u.fx) * u.t,
        7.5 + Math.sin(u.t * Math.PI) * 4,
        u.fz + (u.tz - u.fz) * u.t);
      s.material.opacity = 1 - u.t * 0.6;
    }

    // Longest-wait highlight
    const snap = opts.snapshot;
    if (snap && snap.longestWait > 20 && this.vehMeshes.has(snap.longestId)) {
      const vm = this.vehMeshes.get(snap.longestId);
      this.ring.visible = true;
      this.ring.position.set(vm.position.x, 0.3, vm.position.z);
      this.ring.scale.setScalar(1 + Math.sin(this.t * 4) * 0.12);
    } else this.ring.visible = false;

    // Rain
    if (this.rainCount > 0) {
      const cam = this.refs.camera.position;
      for (let i = 0; i < this.rainCount; i++) {
        let y = this.rainPos[i * 3 + 1] - 55 * dt;
        if (y < 0) {
          y = 90;
          this.rainPos[i * 3] = cam.x + (Math.random() - 0.5) * 320;
          this.rainPos[i * 3 + 2] = cam.z + (Math.random() - 0.5) * 320;
        }
        this.rainPos[i * 3 + 1] = y;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
    }
  }

  spawnPacket(pk) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.packetTex, color: 0x00e5ff, transparent: true }));
    sp.scale.setScalar(2.2);
    sp.userData = { ...pk, t: 0 };
    this.scene.add(sp);
    this.packetSprites.push(sp);
  }

  setEnvironment(weather, tod) {
    const { scene, hemi, sun, lampMats } = this.refs;
    const night = tod.night;
    const sky = night ? 0x0b1024 : weather.sky;
    scene.background.setHex(sky);
    scene.fog.color.setHex(sky);
    scene.fog.density = weather.fog + (night ? 0.0012 : 0);
    sun.intensity = night ? 0.12 : (weather.code === 0 ? 1.6 : weather.code === 1 ? 0.9 : 0.55);
    hemi.intensity = night ? 0.25 : (weather.code === 0 ? 0.9 : 0.6);
    for (const lm of lampMats) lm.emissiveIntensity = night ? 1.6 : 0.0;
    this.rainCount = weather.rain;
    this.rain.geometry.setDrawRange(0, weather.rain);
    this.rain.visible = weather.rain > 0;
  }
}
