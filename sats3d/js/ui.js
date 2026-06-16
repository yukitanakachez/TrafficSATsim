import { PHASE_NAMES } from './config.js';

const PHASE_BG = ['#2e8b57', '#4682b4', '#d2802a'];

// Builds the control panel + stats overlay. All interaction flows out through
// the callbacks object `cb`; stats flow in via update(snapshot, twinSnapshot, agent).
export class UI {
  constructor(cb) {
    this.cb = cb;
    const left = document.getElementById('left-panel');
    left.innerHTML = `
      <h1>SATS <span>smart traffic 3D</span></h1>
      <label>Controller
        <select id="mode">
          <option value="sats">SATS priority scorer</option>
          <option value="rl">RL agent (learning live)</option>
          <option value="fixed">Fixed timing</option>
        </select>
      </label>
      <label>Sim speed
        <span class="btnrow" id="speed">
          <button data-v="0">⏸</button><button data-v="1" class="on">1×</button>
          <button data-v="2">2×</button><button data-v="5">5×</button>
        </span>
      </label>
      <label>Weather
        <select id="weather">
          <option value="clear">Clear</option>
          <option value="rain">Rain</option>
          <option value="heavy">Heavy rain</option>
        </select>
      </label>
      <label>Time of day
        <select id="tod">
          <option value="day">Midday</option>
          <option value="rush">Rush hour</option>
          <option value="school">School hours</option>
          <option value="night">Night</option>
        </select>
      </label>
      <label>Spawn rate <output id="spawnOut">45</output> cars/min
        <input type="range" id="spawn" min="5" max="240" value="45">
      </label>
      <label>AV ratio <output id="avOut">30</output>%
        <input type="range" id="av" min="0" max="100" value="30">
      </label>
      <label>AV lateness weight <output id="lwOut">1.0</output>
        <input type="range" id="lw" min="0" max="3" step="0.1" value="1">
      </label>
      <div class="btnrow">
        <button id="ev">🚨 Emergency vehicle</button>
        <button id="ped">🚶 Add pedestrian</button>
      </div>
      <label class="check"><input type="checkbox" id="mesh"> Show mesh packets</label>
      <label class="check"><input type="checkbox" id="compare"> Compare vs fixed timing (restarts)</label>
      <div class="btnrow">
        <button id="cam">📷 First-person</button>
        <button id="resetRl">🧠 Reset RL brain</button>
      </div>`;
    this.right = document.getElementById('right-panel');

    const $ = (id) => document.getElementById(id);
    $('mode').onchange = (e) => cb.onMode(e.target.value);
    $('weather').onchange = (e) => cb.onWeather(e.target.value);
    $('tod').onchange = (e) => cb.onTod(e.target.value);
    $('spawn').oninput = (e) => { $('spawnOut').value = e.target.value; cb.onSpawnRate(+e.target.value); };
    $('av').oninput = (e) => { $('avOut').value = e.target.value; cb.onAvRatio(+e.target.value / 100); };
    $('lw').oninput = (e) => { $('lwOut').value = (+e.target.value).toFixed(1); cb.onLateWeight(+e.target.value); };
    $('ev').onclick = () => cb.onEv();
    $('ped').onclick = () => cb.onPed();
    $('mesh').onchange = (e) => cb.onMesh(e.target.checked);
    $('compare').onchange = (e) => cb.onCompare(e.target.checked);
    $('resetRl').onclick = () => cb.onResetRl();
    this.camBtn = $('cam');
    this.camBtn.onclick = () => cb.onCamToggle();
    for (const b of document.querySelectorAll('#speed button')) {
      b.onclick = () => {
        document.querySelectorAll('#speed button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        cb.onSpeed(+b.dataset.v);
      };
    }
  }

  setCamLabel(mode) {
    this.camBtn.textContent = mode === 'fp' ? '📷 Overhead view' : '📷 First-person';
  }

  fmt(x, d = 1) { return Number.isFinite(x) ? x.toFixed(d) : '–'; }

  update(s, twin, agent, mode) {
    const f = this.fmt;
    const phaseGrid = s.phases.map((p, i) =>
      `<span class="cell" style="background:${p.clearing ? '#666' : PHASE_BG[p.phase]}">${p.clearing ? '·' : PHASE_NAMES[p.phase]}</span>${(i % 3 === 2) ? '<br>' : ''}`
    ).join('');

    let cmp = '';
    if (twin) {
      cmp = `
      <h2>SATS vs fixed timing</h2>
      <table>
        <tr><th></th><th>${s.mode === 'rl' ? 'RL' : 'SATS'}</th><th>Fixed</th></tr>
        <tr><td>avg wait now</td><td>${f(s.avgCurrentWait)}s</td><td>${f(twin.avgCurrentWait)}s</td></tr>
        <tr><td>avg trip wait</td><td>${f(s.avgTripWait)}s</td><td>${f(twin.avgTripWait)}s</td></tr>
        <tr><td>cleared</td><td>${s.cleared}</td><td>${twin.cleared}</td></tr>
        <tr><td>AV exit lateness</td><td>${f(s.avgExitLateness)}s</td><td>${f(twin.avgExitLateness)}s</td></tr>
        <tr><td>AVs late now</td><td>${s.avSlight + s.avLate}</td><td>${twin.avSlight + twin.avLate}</td></tr>
      </table>`;
    }

    let rl = '';
    if (mode === 'rl' && agent) {
      rl = `
      <h2>RL agent (shared brain)</h2>
      <div class="kv"><span>decisions</span><b>${agent.steps}</b></div>
      <div class="kv"><span>epsilon</span><b>${f(agent.epsilon(), 2)}</b></div>
      <div class="kv"><span>replay buffer</span><b>${agent.buffer.length}</b></div>
      <div class="kv"><span>TD loss (ema)</span><b>${f(agent.lossEma, 3)}</b></div>
      <div class="kv"><span>reward (ema)</span><b>${f(agent.rewardEma, 2)}</b></div>
      <canvas id="spark" width="190" height="36"></canvas>`;
    }

    this.right.innerHTML = `
      <h2>Live stats <span class="dim">t=${Math.floor(s.time)}s</span></h2>
      <div class="kv"><span>vehicles active</span><b>${s.active}</b></div>
      <div class="kv"><span>pedestrians</span><b>${s.peds}</b></div>
      <div class="kv"><span>avg wait (now)</span><b>${f(s.avgCurrentWait)}s</b></div>
      <div class="kv"><span>longest wait</span><b class="${s.longestWait > 60 ? 'bad' : ''}">${f(s.longestWait, 0)}s</b></div>
      <div class="kv"><span>cleared</span><b>${s.cleared}</b></div>
      <div class="kv"><span>avg trip wait</span><b>${f(s.avgTripWait)}s</b></div>
      <h2>AVs</h2>
      <div class="kv"><span>on time / late / very late</span>
        <b><i class="g">${s.avEarly + s.avOn}</i> / <i class="y">${s.avSlight}</i> / <i class="r">${s.avLate}</i></b></div>
      <div class="kv"><span>avg lateness at exit</span><b>${f(s.avgExitLateness)}s</b> <span class="dim">(${s.avDone} done)</span></div>
      <div class="kv"><span>ETA model</span><b>${s.eta.n} samples, MAE ${f(s.eta.mae, 0)}s</b></div>
      <h2>Signal phases</h2>
      <div class="grid">${phaseGrid}</div>
      ${cmp}${rl}`;

    if (mode === 'rl' && agent) this.drawSpark(agent.rewardHistory);
  }

  drawSpark(hist) {
    const cv = document.getElementById('spark');
    if (!cv || !hist.length) return;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.strokeStyle = '#3de0a8';
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const x = (i / Math.max(1, hist.length - 1)) * cv.width;
      const y = cv.height - ((hist[i] + 6) / 6) * (cv.height - 4) - 2;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
}
