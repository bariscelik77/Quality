// Layouts, camera framing and the data overlay, drawn on a 2D canvas.
// Port of the desktop app's overlay.py / preview.py.
import { FIELDS, detectSport, presetStyle, fieldValue, cadenceMultiplier, fmtPace } from './fields.js';

export const FONT = 'Barlow';
const WHITE = '#fff', SOFT = 'rgba(255,255,255,.67)', ACCENT = '#ff7a3d';
const ZONES = [[0.6, '#8e9aaf', 'Z1'], [0.7, '#3fa9f5', 'Z2'], [0.8, '#43c46b', 'Z3'], [0.9, '#f5a623', 'Z4'], [9, '#f0453a', 'Z5']];
export const hrZone = (hr, max) => ZONES.find(z => hr / max < z[0]) || ZONES[4];

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export async function loadFonts() {
  try { await Promise.all(['500', '600', '700'].map(w => document.fonts.load(`${w} 40px ${FONT}`))); } catch {}
}

/** part of the camera picture to use; 'zoom' trims the stamp strip off the bottom (and the sides, keeping the shape) */
export function sourceCrop(w, h, stampMode, box) {
  if (stampMode !== 'zoom') return [0, 0, w, h];
  const keep = Math.max(0.8, Math.min(1, box[1] - 0.005));
  const ch = Math.floor((h * keep) / 2) * 2, cw = Math.floor((w * keep) / 2) * 2;
  return [Math.floor((w - cw) / 2), 0, cw, ch];
}

export function makeLayout(kind, srcW, srcH) {
  if (kind === 'landscape') {
    const H = srcH > 760 ? 1080 : 720, W = Math.round((H * 16) / 9 / 2) * 2, bh = Math.floor((H * 0.3) / 2) * 2;
    return { W, H, kind, video: [0, 0, W, H], band: [0, H - bh, W, bh] };
  }
  const W = 1080, H = 1920;
  if (kind === 'vertical-fit') {
    const vh = Math.round((W * srcH) / srcW / 2) * 2, vy = Math.floor((H - vh) / 4) * 2;
    return { W, H, kind, video: [0, vy, W, vh], band: [0, vy + vh, W, H - vy - vh] };
  }
  return { W, H, kind, video: [0, 0, W, H], band: [0, H - 640, W, 640] };
}

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const font = (px, weight = 700) => `${weight} ${Math.round(px)}px ${FONT}, "Segoe UI", sans-serif`;

function text(g, x, y, s, px, { weight = 700, fill = WHITE, align = 'left', shadow = true } = {}) {
  g.font = font(px, weight); g.textAlign = align; g.textBaseline = 'alphabetic';
  if (shadow) { g.lineWidth = Math.max(2, px / 14); g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineJoin = 'round'; g.strokeText(s, x, y); }
  g.fillStyle = fill; g.fillText(s, x, y);
  return g.measureText(s).width;
}
/** largest size (size → min) at which s fits maxW, on one line or two balanced lines → [px, lines] */
function fitLines(g, s, maxW, size, min, weight = 700, wrap = true) {
  const words = s.split(' ');
  let best = [s];
  const w = (t, px) => { g.font = font(px, weight); return g.measureText(t).width; };
  for (let px = size; px >= min; px -= 2) {
    if (w(s, px) <= maxW) return [px, [s]];
    if (wrap && words.length > 1) {
      let pick = null, pickW = Infinity;
      for (let k = 1; k < words.length; k++) {
        const a = words.slice(0, k).join(' '), b = words.slice(k).join(' '), m = Math.max(w(a, px), w(b, px));
        if (m < pickW) { pickW = m; pick = [a, b]; }
      }
      best = pick;
      if (pickW <= maxW) return [px, pick];
    }
  }
  return [min, best];
}
function rrect(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
function vgrad(g, x, y, w, h, a0, a1) {
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, `rgba(0,0,0,${a0})`); gr.addColorStop(1, `rgba(0,0,0,${a1})`);
  g.fillStyle = gr; g.fillRect(x, y, w, h);
}
function heart(g, cx, cy, s, fill) {
  const r = s * 0.27;
  g.fillStyle = fill; g.beginPath();
  g.ellipse(cx - r, cy - r * 0.6, r, r, 0, 0, Math.PI * 2);
  g.ellipse(cx + r, cy - r * 0.6, r, r, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(cx - 1.93 * r, cy - 0.35 * r); g.lineTo(cx + 1.93 * r, cy - 0.35 * r); g.lineTo(cx, cy + 1.9 * r); g.closePath(); g.fill();
}

// ---------------------------------------------------------------- camera picture
// blurred side-fill for 9:16: a mid-size canvas with a blur filter, scaled up with plain smoothing.
// (A tiny canvas upscaled with imageSmoothingQuality 'high' cost ~20 ms a frame; this is ~3 ms.)
let bgMid = null;
export function drawCamera(g, v, L, crop) {
  const [cx, cy, cw, ch] = crop, { W, H } = L;
  if (L.kind === 'landscape') { g.drawImage(v, cx, cy, cw, ch, 0, 0, W, H); return; }
  if (L.kind === 'vertical-crop') {
    const w = (ch * W) / H, x = cx + (cw - w) / 2;
    g.drawImage(v, x, cy, w, ch, 0, 0, W, H); return;
  }
  // vertical-fit: soft blurred cover background (drawn tiny, then scaled up) + the whole picture in the middle
  const sw = 270, sh = 480;
  if (!bgMid) { bgMid = mk(sw, sh); bgMid.getContext('2d').filter = 'blur(6px)'; }
  const w = (ch * sw) / sh;
  bgMid.getContext('2d').drawImage(v, cx + (cw - w) / 2, cy, w, ch, 0, 0, sw, sh);
  g.imageSmoothingQuality = 'low';
  g.drawImage(bgMid, 0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,.38)'; g.fillRect(0, 0, W, H);
  const [vx, vy, vw, vh] = L.video;
  g.drawImage(v, cx, cy, cw, ch, vx, vy, vw, vh);
}

// ---------------------------------------------------------------- data overlay
export class Overlay {
  constructor(ride, L, { maxHr = 185, title = '', tzHours = 0, style = null } = {}) {
    Object.assign(this, { ride, L, maxHr, title: title || ride.name, tzHours });
    this.style = { ...presetStyle(detectSport(ride.type), ride.has), ...(style || {}) };
    this.sport = this.style.sport;
    this.cadMul = ride.has.cad ? cadenceMultiplier(this.sport, ride.d.cad) : 1;
    const [, , bw, bh] = L.band;
    this.bw = bw; this.bh = bh;
    this.u = L.kind === 'landscape' ? Math.min(L.W, L.H) / 1080 : 1;
    this.total = Math.max(ride.d.dist[ride.n - 1], 1);
    this.buildBase();
  }

  buildBase() {
    const { u, bw, bh, L, ride } = this, k = L.kind;
    const base = mk(bw, bh), g = base.getContext('2d');
    if (k === 'landscape') {
      vgrad(g, 0, 0, bw, bh, 0, 0.72);
      const pad = 28 * u, ms = bh - 2 * pad;
      this.map = [bw - pad - ms, pad, ms];
      const pw = bw * 0.22, ph = bh * 0.42;
      this.prof = [this.map[0] - 24 * u - pw, bh - pad - ph, pw, ph];
    } else {
      vgrad(g, 0, 0, bw, bh, k === 'vertical-fit' ? 0.24 : 0, k === 'vertical-fit' ? 0.6 : 0.8);
      const pad = 48, top = 400, ms = Math.min(bh - top - 30, 230);
      this.map = [bw - pad - ms, top, ms];
      this.prof = [pad, top + ms - 160, bw - 2 * pad - ms - 30, 160];
    }
    // map panel + route
    const [mx, my, ms] = this.map, d = ride.d;
    g.fillStyle = 'rgba(10,12,16,.43)'; rrect(g, mx, my, ms, ms, k === 'landscape' ? 18 * u : 24); g.fill();
    let lat = 0; for (let i = 0; i < ride.n; i++) lat += d.lat[i]; lat /= ride.n;
    const cosl = Math.cos((lat * Math.PI) / 180);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const xs = new Float64Array(ride.n), ys = new Float64Array(ride.n);
    for (let i = 0; i < ride.n; i++) {
      xs[i] = d.lon[i] * cosl; ys[i] = -d.lat[i];
      x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]); y0 = Math.min(y0, ys[i]); y1 = Math.max(y1, ys[i]);
    }
    const span = Math.max(x1 - x0, y1 - y0, 1e-9), inner = ms * 0.82;
    const ox = mx + (ms - (inner * (x1 - x0)) / span) / 2, oy = my + (ms - (inner * (y1 - y0)) / span) / 2;
    this.rx = xs.map(x => ox + ((x - x0) / span) * inner);
    this.ry = ys.map(y => oy + ((y - y0) / span) * inner);
    this.step = Math.max(1, Math.floor(ride.n / 800));
    this.lw = Math.max(2, 4 * u);
    const route = (to, color, w) => {
      g.strokeStyle = color; g.lineWidth = w; g.lineJoin = g.lineCap = 'round'; g.beginPath();
      for (let i = 0; i <= to; i += this.step) i ? g.lineTo(this.rx[i], this.ry[i]) : g.moveTo(this.rx[i], this.ry[i]);
      g.stroke();
    };
    route(ride.n - 1, 'rgba(0,0,0,.47)', this.lw + Math.max(2, 3 * u));
    route(ride.n - 1, 'rgba(255,255,255,.6)', this.lw);

    // elevation profile: dim on the base, bright copy revealed per frame
    const [px, py, pw, ph] = this.prof;
    let lo = Infinity, hi = -Infinity; for (let i = 0; i < ride.n; i++) { lo = Math.min(lo, d.ele[i]); hi = Math.max(hi, d.ele[i]); }
    const rng = Math.max(hi - lo, 20), cols = Math.max(2, Math.floor(pw)), top = 0.12 * ph;
    this.profY = new Float64Array(cols);
    let j = 0;
    for (let c = 0; c < cols; c++) {
      const dist = (c / (cols - 1)) * this.total;
      while (j < ride.n - 2 && d.dist[j + 1] < dist) j++;
      this.profY[c] = py + ph - ((d.ele[j] - lo) / rng) * (ph - top) - 2;
    }
    const poly = (gg, fill, stroke, lw) => {
      gg.beginPath(); gg.moveTo(px, py + ph);
      for (let c = 0; c < cols; c++) gg.lineTo(px + c, this.profY[c]);
      gg.lineTo(px + cols - 1, py + ph); gg.closePath(); gg.fillStyle = fill; gg.fill();
      gg.beginPath(); for (let c = 0; c < cols; c++) c ? gg.lineTo(px + c, this.profY[c]) : gg.moveTo(px, this.profY[0]);
      gg.strokeStyle = stroke; gg.lineWidth = lw; gg.stroke();
    };
    poly(g, 'rgba(255,255,255,.22)', 'rgba(255,255,255,.55)', Math.max(1, 2 * u));
    this.bright = mk(bw, bh);
    poly(this.bright.getContext('2d'), 'rgba(255,122,61,.59)', ACCENT, Math.max(2, 3 * u));
    this.base = base;
  }

  /** draws the live band into g at the layout's band position */
  draw(g, t, label) {
    const v = this.ride.at(t), { u, L } = this;
    const [bx, by] = L.band;
    g.save(); g.translate(bx, by);
    g.drawImage(this.base, 0, 0);
    // profile progress
    const [px, py, pw, ph] = this.prof;
    const frac = Math.min(Math.max(v.dist / this.total, 0), 1), cut = Math.floor(frac * (this.profY.length - 1));
    if (cut > 0) g.drawImage(this.bright, px, py, cut, ph, px, py, cut, ph);
    const yy = this.profY[cut], r = Math.max(4, 7 * u);
    g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = Math.max(1, 2 * u);
    g.beginPath(); g.moveTo(px + cut, yy); g.lineTo(px + cut, py + ph); g.stroke();
    g.beginPath(); g.arc(px + cut, yy, r, 0, Math.PI * 2); g.fillStyle = WHITE; g.fill(); g.strokeStyle = ACCENT; g.lineWidth = Math.max(2, 3 * u); g.stroke();
    // map progress + dot
    const i = Math.round(v.idx);
    g.strokeStyle = ACCENT; g.lineWidth = this.lw; g.lineJoin = g.lineCap = 'round'; g.beginPath();
    g.moveTo(this.rx[0], this.ry[0]);
    for (let k = this.step; k <= i; k += this.step) g.lineTo(this.rx[k], this.ry[k]);
    g.lineTo(this.rx[i], this.ry[i]); g.stroke();
    const dr = Math.max(5, 9 * u);
    g.beginPath(); g.arc(this.rx[i], this.ry[i], dr + 3, 0, Math.PI * 2); g.fillStyle = 'rgba(0,0,0,.47)'; g.fill();
    g.beginPath(); g.arc(this.rx[i], this.ry[i], dr, 0, Math.PI * 2); g.fillStyle = WHITE; g.fill(); g.strokeStyle = ACCENT; g.lineWidth = Math.max(2, 4 * u); g.stroke();

    if (L.kind === 'landscape') this.numbersLandscape(g, v, label); else this.numbersVertical(g, v, label);
    g.restore();
  }

  smallStats(v) {
    return this.style.small.map(k => {
      const [val, unit] = fieldValue(k, v, this.ride.t0, this.cadMul);
      return [FIELDS[k][0], val, ['', '%', '°C', 'W'].includes(unit) ? unit : unit.toLowerCase()];
    });
  }

  bigField(g, key, x, y, size, v) {
    if (key === 'hr') return this.hr(g, x, y, size, v);
    const [val, unit] = fieldValue(key, v, this.ride.t0, this.cadMul);
    return this.big(g, x, y, val, unit, size);
  }

  big(g, x, y, value, unit, size) {
    const w = text(g, x, y, value, size, { weight: 700 });
    const w2 = text(g, x + w + size * 0.08, y, unit, size * 0.28, { weight: 600, fill: SOFT });
    return x + w + size * 0.08 + w2;
  }

  hr(g, x, y, size, v) {
    if (!Number.isFinite(v.hr)) return x;
    const [, col, zl] = hrZone(v.hr, this.maxHr), hs = size * 0.42;
    heart(g, x + hs * 0.55, y - size * 0.42, hs, col);
    const x2 = this.big(g, x + hs * 1.25, y, v.hr.toFixed(0), 'BPM', size);
    g.font = font(size * 0.24, 700);
    const tw = g.measureText(zl).width, px = x + hs * 1.25 + 2, py = y + size * 0.12;
    g.fillStyle = col; rrect(g, px, py, tw + size * 0.2, size * 0.32, size * 0.08); g.fill();
    g.fillStyle = '#0f0f0f'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText(zl, px + size * 0.1, py + size * 0.17);
    const bx = px + tw + size * 0.32, bw = Math.max(size * 1.4, x2 - px - tw - size * 0.32), bm = py + size * 0.16, bt = size * 0.035;
    const fr = Math.min(Math.max(v.hr / this.maxHr, 0.5), 1);
    g.fillStyle = 'rgba(255,255,255,.27)'; rrect(g, bx, bm - bt, bw, bt * 2, bt); g.fill();
    g.fillStyle = col; rrect(g, bx, bm - bt, Math.max(bt * 2, (bw * (fr - 0.5)) / 0.5), bt * 2, bt); g.fill();
    return x2;
  }

  chip(g, x, y, s, size, center = false) {
    g.font = font(size, 600);
    const tw = g.measureText(s).width;
    if (center) x -= (tw + size) / 2;
    g.fillStyle = ACCENT; rrect(g, x, y, tw + size, size * 1.6, size * 0.8); g.fill();
    g.fillStyle = WHITE; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText(s, x + size / 2, y + size * 0.82);
  }

  numbersLandscape(g, v, label) {
    const { u, bh } = this, pad = 40 * u, big = 112 * u, yb = bh - 66 * u;
    let x = pad;
    this.style.big.slice(0, 2).forEach((k, i) => { x = this.bigField(g, k, i ? Math.max(x + 48 * u, pad + 400 * u) : x, yb, big, v); });
    const gx = Math.max(x + 48 * u, pad + 740 * u), colW = 190 * u;
    this.smallStats(v).slice(0, 6).forEach(([lab, val, unit], k) => {
      const cx = gx + Math.floor(k / 2) * colW, cy = bh - 132 * u + (k % 2) * 88 * u;
      if (cx + colW * 0.8 > this.prof[0]) return;
      text(g, cx, cy - 40 * u, lab, 20 * u, { weight: 600, fill: SOFT });
      text(g, cx, cy, val + (unit ? ` ${unit}` : ''), 40 * u);
    });
    if (label) this.chip(g, pad, 16 * u, label, 26 * u);
  }

  numbersVertical(g, v, label) {
    const bw = this.bw, pad = 56, big = 140, yb = 228;
    if (label) this.chip(g, bw / 2, 30, label, 28, true);
    this.style.big.slice(0, 2).forEach((k, i) => this.bigField(g, k, i ? bw / 2 + 40 : pad, yb, big, v));
    const st = this.smallStats(v).slice(0, 4), colw = (bw - 2 * pad) / st.length, yl = yb + 96;
    st.forEach(([lab, val, unit], k) => {
      text(g, pad + k * colw, yl, lab, 24, { weight: 600, fill: SOFT });
      text(g, pad + k * colw, yl + 54, val + (unit ? ` ${unit}` : ''), 48);
    });
  }

  /** ride title + summary, full frame; alpha for fading */
  drawTitle(g, summary, alpha = 1) {
    if (alpha <= 0) return;
    const { W, H, kind } = this.L, s = summary;
    const local = new Date((s.start.getTime() / 1000 + this.tzHours * 3600) * 1000);
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][local.getUTCMonth()];
    const date = `${local.getUTCDate()} ${mon} ${local.getUTCFullYear()}  ·  ${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
    const bits = [`${s.km.toFixed(1)} km`, `${s.gain.toFixed(0)} m climb`, fmtTime(s.moving),
      this.sport === 'running' || this.sport === 'walking' ? `${fmtPace(s.avgSpeed)} /km avg` : `${s.avgSpeed.toFixed(1)} km/h avg`];
    if (s.avgHr) bits.push(`${s.avgHr.toFixed(0)} bpm avg`);
    g.save(); g.globalAlpha = alpha;
    const title = String(this.title || '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    if (kind === 'landscape') {
      const u = this.u, x = 56 * u, [px, lines] = fitLines(g, title, W - 2 * x, 86 * u, 46 * u), lh = px * 1.08, dy = lh * (lines.length - 1);
      vgrad(g, 0, 0, W, H * 0.38 + dy, 0.75, 0);
      lines.forEach((ln, k) => text(g, x, 118 * u + k * lh, ln, px));
      g.fillStyle = ACCENT; rrect(g, x, 140 * u + dy, 90 * u, 7 * u, 3); g.fill();
      text(g, x, 196 * u + dy, date, 34 * u, { weight: 600, fill: SOFT });
      const line = bits.join('   ·   '), [sp] = fitLines(g, line, W - 2 * x, 34 * u, 22 * u, 600, false);
      text(g, x, 250 * u + dy, line, sp, { weight: 600 });
    } else {
      const areaH = kind === 'vertical-fit' ? this.L.video[1] : 560, cx = W / 2, yb = areaH - 70;
      if (kind === 'vertical-crop') vgrad(g, 0, 0, W, 620, 0.8, 0);
      const [px, lines] = fitLines(g, title, W - 120, 92, 54), lh = px * 1.08, top = yb - 170 - lh * (lines.length - 1);
      lines.forEach((ln, k) => text(g, cx, top + k * lh, ln, px, { align: 'center' }));
      g.fillStyle = ACCENT; rrect(g, cx - 50, yb - 140, 100, 7, 3); g.fill();
      text(g, cx, yb - 80, date, 38, { weight: 600, fill: SOFT, align: 'center' });
      text(g, cx, yb - 16, bits.slice(0, 3).join('   ·   '), 36, { weight: 600, align: 'center' });
      if (bits.length > 3) text(g, cx, yb + 34, bits.slice(3).join('   ·   '), 36, { weight: 600, fill: SOFT, align: 'center' });
    }
    g.restore();
  }
}
