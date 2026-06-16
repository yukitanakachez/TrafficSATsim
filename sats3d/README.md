# SATS 3D — Smart Adaptive Traffic Simulation

A real-time 3D traffic simulation where AI-controlled intersections coordinate
with each other and with self-driving vehicles. Runs entirely in the browser —
no build step, no install.

## Run it

```bash
cd sats3d
python3 -m http.server 8741
# open http://localhost:8741
```

(Any static file server works. Internet access is needed once to fetch Three.js
from the CDN.)

## Controls

| Input | Action |
|---|---|
| **O** or 📷 button | Toggle overhead ⇄ first-person walk mode |
| Walk mode | **WASD** move, mouse look, **Space/C** up/down, **Shift** fast, **Esc** exit |
| **P** | Spawn pedestrian at nearest intersection |
| Overhead click | Add a pedestrian at that intersection |
| Left panel | Controller mode, sim speed (pause/1×/2×/5×), weather, time of day, spawn rate, AV ratio, AV lateness weight, emergency vehicle, mesh-packet overlay, comparison mode |

## What's real about the "AI"

Three genuinely learning/model-based systems, all implemented from scratch
(`js/ml/`, no libraries):

1. **Traffic physics — Intelligent Driver Model (IDM).** Every vehicle solves
   the IDM car-following equation each 0.2 s step, so queues, shockwaves, and
   merging emerge from the physics rather than being scripted. AVs run tighter
   headways and smoother acceleration than the human-driver parameter set.
   Weather rescales acceleration, desired gap, and top speed.

2. **Reinforcement-learning signal control (`RL agent` mode).** A DQN-style
   agent — a 24→48→32→3 neural network with hand-written backpropagation,
   experience replay, epsilon-greedy exploration, and a target network — picks
   each intersection's next phase. One brain is shared by all nine
   intersections, so experience pools ×9. Reward is negative pressure (queues,
   AV lateness, pedestrian waiting). It starts random (ε=1) and visibly
   improves over ~10–20 sim-minutes; weights persist to localStorage. The hard
   safety rules (min/max green, all-red clearance, pedestrian crossing-hold)
   are enforced outside the network and can never be overridden by it.

3. **Online ETA prediction.** AVs estimate arrival with a linear regression
   model trained by SGD on completed trips (features: remaining distance,
   queued vehicles ahead, signals ahead, weather, demand, network wait). The
   stats panel shows its sample count and live MAE.

The default **SATS priority scorer** is the hand-tuned heuristic from the
design plan: queue + wait (exponential past 60 s to prevent starvation) +
AV lateness + pedestrian demand (vulnerable ×2) + neighbor mesh pressure
(upstream platoons, downstream backpressure) − recently-served penalty.

## Comparison mode

Ticking "Compare vs fixed timing" restarts the world and runs a second,
invisible simulation with classic fixed-time signals. Both worlds share one
seeded RNG protocol — every spawn (vehicle, pedestrian, emergency run) is
pre-rolled identically — so the metric table is a true controlled experiment.

## Layout

```
index.html            shell + Three.js import map
js/config.js          all tunables (grid size, IDM, scoring weights, RL hyperparams)
js/network.js         road graph, lanes, turn connectors, BFS routing
js/vehicles.js        IDM physics, signal compliance, left-turn yield, AV ETA
js/pedestrians.js     vulnerability types, crossing-hold
js/signals.js         phase state machine + priority scorer (3 controller modes)
js/sim.js             tick orchestration, deterministic spawning, stats, RL plumbing
js/ml/nn.js           dense NN + manual backprop
js/ml/rl.js           shared DQN agent (replay, target net, persistence)
js/ml/eta.js          online ETA regression
js/render/scene.js    static world (roads, signals, buildings, lamps)
js/render/dynamics.js pooled entity meshes, lamps, packets, rain, environment
js/ui.js, js/main.js  controls, stats, camera, main loop
```

Grid size is configurable in `config.js` (`grid.nx/ny`) — everything else
adapts automatically.
