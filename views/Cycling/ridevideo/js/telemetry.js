// Ride file (GPX from Strava) → one sample per second: lat, lon, ele, hr, cad, power, dist, speed, grade, moving.
// Port of the desktop app's telemetry.py.

const R = 6371000;
const rad = d => (d * Math.PI) / 180;
function hav(la1, lo1, la2, lo2) {
  const p1 = rad(la1), p2 = rad(la2), dp = p2 - p1, dl = rad(lo2 - lo1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const rolling = (arr, w) => {
  const h = Math.floor(w / 2), out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(arr.length - 1, i + (w - 1 - h)); k++) { s += arr[k]; n++; }
    out[i] = s / n;
  }
  return out;
};
function interp(grid, xs, ys) {
  const out = new Float64Array(grid.length);
  let j = 0;
  for (let i = 0; i < grid.length; i++) {
    const x = grid[i];
    while (j < xs.length - 2 && xs[j + 1] < x) j++;
    if (x <= xs[0]) out[i] = ys[0];
    else if (x >= xs[xs.length - 1]) out[i] = ys[ys.length - 1];
    else { const f = (x - xs[j]) / (xs[j + 1] - xs[j] || 1); out[i] = ys[j] + (ys[j + 1] - ys[j]) * f; }
  }
  return out;
}

export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This GPX file could not be read.');
  const byTag = (el, name) => [...el.getElementsByTagName('*')].find(e => e.localName === name);
  const trk = [...doc.getElementsByTagName('*')].find(e => e.localName === 'trk');
  const name = (trk && byTag(trk, 'name')?.textContent.trim()) || 'Ride';
  const rows = [];
  for (const p of doc.getElementsByTagName('*')) {
    if (p.localName !== 'trkpt') continue;
    const tEl = byTag(p, 'time');
    if (!tEl) continue;
    const r = { t: Date.parse(tEl.textContent.trim()) / 1000, lat: +p.getAttribute('lat'), lon: +p.getAttribute('lon') };
    const ele = byTag(p, 'ele'); if (ele) r.ele = +ele.textContent;
    for (const e of p.getElementsByTagName('*')) {
      const v = parseFloat(e.textContent); if (!Number.isFinite(v)) continue;
      const k = e.localName.toLowerCase();
      if (k === 'hr') r.hr = v; else if (k === 'cad' || k === 'cadence') r.cad = v;
      else if (k === 'power' || k === 'watts') r.power = v; else if (k === 'atemp') r.temp = v;
    }
    if (Number.isFinite(r.t)) rows.push(r);
  }
  return { name, rows };
}

export function buildRide({ name, rows }) {
  rows = rows.filter((r, i, a) => i === 0 || r.t > a[i - 1].t);
  if (rows.length < 10) throw new Error('The ride file has too few timed points.');
  const has = {};
  for (const k of ['hr', 'cad', 'power', 'ele']) has[k] = rows.some(r => Number.isFinite(r[k]));
  const t0 = Math.floor(rows[0].t), t1 = Math.ceil(rows[rows.length - 1].t), n = t1 - t0 + 1;
  const grid = Float64Array.from({ length: n }, (_, i) => t0 + i);
  const col = k => {
    const pts = rows.filter(r => Number.isFinite(r[k]));
    return pts.length ? interp(grid, pts.map(r => r.t), pts.map(r => r[k])) : new Float64Array(n).fill(NaN);
  };
  const d = { t: grid, lat: col('lat'), lon: col('lon'), ele: has.ele ? col('ele') : new Float64Array(n), hr: col('hr'), cad: col('cad'), power: col('power') };

  // long gaps = paused
  const paused = new Uint8Array(n);
  for (let i = 0; i < rows.length - 1; i++) {
    const gap = rows[i + 1].t - rows[i].t;
    if (gap > 10) { const a = Math.floor(rows[i].t - t0) + 1; for (let k = a; k < a + gap - 1 && k < n; k++) paused[k] = 1; }
  }
  const step = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    let s = hav(d.lat[i - 1], d.lon[i - 1], d.lat[i], d.lon[i]);
    if (paused[i] || s > 30 || !Number.isFinite(s)) s = 0;
    step[i] = s;
  }
  d.dist = new Float64Array(n);
  for (let i = 1; i < n; i++) d.dist[i] = d.dist[i - 1] + step[i];
  d.speed = rolling(step.map(s => s * 3.6), 5);
  for (let i = 0; i < n; i++) if (paused[i]) d.speed[i] = 0;
  d.ele = rolling(d.ele, 15);
  const w = 5, g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = Math.min(n - 1, i + w), b = Math.max(0, i - w), dd = d.dist[f] - d.dist[b];
    g[i] = dd > 15 ? ((d.ele[f] - d.ele[b]) / dd) * 100 : 0;
  }
  d.grade = rolling(g, 5).map(v => Math.max(-30, Math.min(30, v)));
  d.moving = Uint8Array.from(d.speed, s => (s > 3 ? 1 : 0));
  return new Ride(name, d, has, n);
}

export class Ride {
  constructor(name, d, has, n) { Object.assign(this, { name, d, has, n }); this.t0 = d.t[0]; this.t1 = d.t[n - 1]; }

  /** values at UTC seconds t (clamped, linear) */
  at(t) {
    const i = Math.max(0, Math.min(this.n - 1, t - this.t0)), lo = Math.floor(i), hi = Math.min(lo + 1, this.n - 1), f = i - lo;
    const v = { idx: i };
    for (const k of ['lat', 'lon', 'ele', 'hr', 'cad', 'power', 'dist', 'speed', 'grade']) {
      const a = this.d[k][lo], b = this.d[k][hi];
      v[k] = Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * f : NaN;
    }
    v.t = t;
    return v;
  }

  summary() {
    const d = this.d; let gain = 0, mov = 0, sp = 0, hr = 0, hrN = 0, maxHr = 0, maxSp = 0;
    for (let i = 0; i < this.n; i++) {
      if (i) gain += Math.max(0, d.ele[i] - d.ele[i - 1]);
      if (d.moving[i]) { mov++; sp += d.speed[i]; }
      maxSp = Math.max(maxSp, d.speed[i]);
      if (Number.isFinite(d.hr[i])) { hr += d.hr[i]; hrN++; maxHr = Math.max(maxHr, d.hr[i]); }
    }
    return {
      name: this.name, start: new Date(this.t0 * 1000), duration: this.t1 - this.t0, moving: mov,
      km: d.dist[this.n - 1] / 1000, gain, maxSpeed: maxSp, avgSpeed: mov ? sp / mov : 0,
      avgHr: hrN ? hr / hrN : null, maxHr: hrN ? maxHr : null,
    };
  }
}

export async function loadRideFile(file) {
  const text = await file.text();
  if (!/\.gpx$/i.test(file.name) && !text.includes('<gpx')) throw new Error('Please use a GPX file (Strava: activity → ⋯ → Export GPX).');
  return buildRide(parseGPX(text));
}
