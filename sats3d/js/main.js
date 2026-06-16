import * as THREE from 'three';
import { CONFIG, WEATHER, TOD } from './config.js';
import { RNG } from './rng.js';
import { Simulation } from './sim.js';
import { QAgent } from './ml/rl.js';
import { buildScene } from './render/scene.js';
import { Visuals } from './render/dynamics.js';
import { UI } from './ui.js';

// ---- shared state ----
const params = {
  spawnRate: CONFIG.spawn.carsPerMin, avRatio: CONFIG.spawn.avRatio,
  weatherKey: 'clear', todKey: 'day', latenessWeight: CONFIG.score.latenessWeight,
};
let speed = 1;
let showPackets = false;
let mode = 'sats';
let seedBase = 1337;

const agent = new QAgent(24, 3, CONFIG.rl, new RNG(7));
if (agent.load()) console.log('RL agent restored from localStorage,', agent.steps, 'decisions');

const uiRng = new RNG((Date.now() % 1e9) | 0);

let sim = new Simulation({ seed: seedBase, mode, params, agent, label: 'SATS' });
let twin = null; // headless fixed-timing twin for comparison mode

const container = document.getElementById('scene');
const refs = buildScene(sim.net, container);
const visuals = new Visuals(refs);
const { camera, renderer } = refs;

// ---- camera: overhead orbit-free view ⇄ first-person fly ----
let camMode = 'over'; // 'over' | 'fp'
let yaw = -0.6, pitch = -0.35;
const fp = { x: 60, y: 16, z: 150 };
const keys = new Set();

function applyOverhead() {
  camera.position.set(0, 265, 95);
  camera.lookAt(0, 0, 0);
}
applyOverhead();

function setCamMode(m) {
  camMode = m;
  ui.setCamLabel(m);
  if (m === 'over') {
    if (document.pointerLockElement) document.exitPointerLock();
    applyOverhead();
  } else {
    renderer.domElement.requestPointerLock();
  }
}

renderer.domElement.addEventListener('click', (e) => {
  if (camMode === 'fp') {
    if (!document.pointerLockElement) renderer.domElement.requestPointerLock();
    return;
  }
  // Overhead: click an intersection slab to drop a pedestrian there.
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(refs.pickMeshes)[0];
  if (hit) spawnPedAt(hit.object.userData.nodeId);
});

document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && camMode === 'fp') {
    // Esc exits walk mode back to overhead
    camMode = 'over';
    ui.setCamLabel('over');
    applyOverhead();
  }
});
document.addEventListener('mousemove', (e) => {
  if (camMode !== 'fp' || !document.pointerLockElement) return;
  yaw -= e.movementX * 0.0022;
  pitch = Math.max(-1.45, Math.min(1.45, pitch - e.movementY * 0.0022));
});
document.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyO') setCamMode(camMode === 'fp' ? 'over' : 'fp');
  if (e.code === 'KeyP') spawnPedNearCamera();
});
document.addEventListener('keyup', (e) => keys.delete(e.code));

function stepCamera(dt) {
  if (camMode !== 'fp') return;
  camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  const sp = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? 70 : 24;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  let mx = 0, mz = 0, my = 0;
  if (keys.has('KeyW')) { mx += fx; mz += fz; }
  if (keys.has('KeyS')) { mx -= fx; mz -= fz; }
  if (keys.has('KeyD')) { mx += rx; mz += rz; }
  if (keys.has('KeyA')) { mx -= rx; mz -= rz; }
  if (keys.has('Space')) my += 1;
  if (keys.has('KeyC')) my -= 1;
  fp.x += mx * sp * dt; fp.z += mz * sp * dt;
  fp.y = Math.max(1.7, Math.min(220, fp.y + my * sp * dt));
  camera.position.set(fp.x, fp.y, fp.z);
}

// ---- UI-triggered spawns (mirrored into the twin for fairness) ----
function spawnPedAt(nodeId) {
  const arm = uiRng.int(0, 3);
  const typeIdx = uiRng.pickWeighted(CONFIG.ped.mix);
  const fromA = uiRng.chance(0.5);
  sim.addPedestrian(nodeId, arm, typeIdx, fromA);
  if (twin) twin.addPedestrian(nodeId, arm, typeIdx, fromA);
}
function spawnPedNearCamera() {
  let best = null, bd = 1e9;
  for (const n of sim.net.intersections) {
    const d = (n.x - camera.position.x) ** 2 + (n.z - camera.position.z) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  if (best) spawnPedAt(best.id);
}
function spawnEv() {
  const nE = sim.net.edgeNodes.length;
  const entry = uiRng.int(0, nE - 1);
  const exit = (entry + 1 + uiRng.int(0, nE - 2)) % nE;
  const routeSeed = uiRng.int(1, 1e9);
  sim.spawnEV(entry, exit, routeSeed);
  if (twin) twin.spawnEV(entry, exit, routeSeed);
}

function restartSims(withTwin) {
  seedBase = (Date.now() % 1e9) | 0;
  sim = new Simulation({ seed: seedBase, mode, params, agent, label: 'SATS' });
  twin = withTwin
    ? new Simulation({ seed: seedBase, mode: 'fixed', params, label: 'Fixed' })
    : null;
  // Network geometry/ids are deterministic, so existing scene refs stay valid.
}

// ---- UI wiring ----
const ui = new UI({
  onMode: (m) => { mode = m; sim.mode = m; },
  onSpeed: (v) => { speed = v; },
  onWeather: (w) => { params.weatherKey = w; applyEnv(); },
  onTod: (t) => { params.todKey = t; applyEnv(); },
  onSpawnRate: (v) => { params.spawnRate = v; },
  onAvRatio: (v) => { params.avRatio = v; },
  onLateWeight: (v) => { params.latenessWeight = v; },
  onEv: spawnEv,
  onPed: () => spawnPedAt(sim.net.intersections[uiRng.int(0, sim.net.intersections.length - 1)].id),
  onMesh: (v) => { showPackets = v; },
  onCompare: (v) => restartSims(v),
  onResetRl: () => { agent.reset(); },
  onCamToggle: () => setCamMode(camMode === 'fp' ? 'over' : 'fp'),
});
ui.setCamLabel('over');

function applyEnv() {
  visuals.setEnvironment(WEATHER[params.weatherKey], TOD[params.todKey]);
}
applyEnv();

window.addEventListener('resize', () => {
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
});

// ---- main loop ----
const clock = new THREE.Clock();
let statTimer = 0, saveTimer = 0, snap = null, twinSnap = null;

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, clock.getDelta());
  if (speed > 0) {
    sim.advance(dt * speed);
    if (twin) twin.advance(dt * speed);
  }
  stepCamera(dt);

  statTimer += dt;
  if (statTimer > 0.25 || !snap) {
    statTimer = 0;
    snap = sim.snapshot();
    twinSnap = twin ? twin.snapshot() : null;
    ui.update(snap, twinSnap, agent, mode);
  }
  saveTimer += dt;
  if (saveTimer > 30) { saveTimer = 0; if (mode === 'rl') agent.save(); }

  visuals.sync(sim, { showPackets, snapshot: snap }, dt);
  renderer.render(refs.scene, camera);
}
loop();
