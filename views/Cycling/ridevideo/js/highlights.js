// Picks the most interesting moments from the ride data. Port of highlights.py.
// A segment = { clip (index), start (s into clip), dur, utc, label }

function rank(x, mask) {
  const idx = []; for (let i = 0; i < x.length; i++) if (mask[i]) idx.push(i);
  const out = new Float64Array(x.length);
  if (idx.length < 2) return out;
  idx.sort((a, b) => x[a] - x[b]);
  idx.forEach((i, r) => (out[i] = r / (idx.length - 1)));
  return out;
}

function score(ride) {
  const d = ride.d, n = ride.n, mov = d.moving;
  const hr = d.hr.map(v => (Number.isFinite(v) ? v : 0));
  const acc = new Float64Array(n);
  for (let i = 0; i < n; i++) acc[i] = Math.max(0, (d.speed[Math.min(n - 1, i + 1)] - d.speed[Math.max(0, i - 1)]) / 2);
  const accS = acc.map((_, i) => (acc[Math.max(0, i - 1)] + acc[i] + acc[Math.min(n - 1, i + 1)]) / 3);
  const p = {
    speed: rank(d.speed, mov), hr: ride.has.hr ? rank(hr, mov) : new Float64Array(n),
    grade: rank(d.grade.map(Math.abs), mov), accel: rank(accS, mov),
  };
  p.total = p.speed.map((s, i) => (mov[i] ? 0.4 * s + 0.25 * p.hr[i] + 0.2 * p.grade[i] + 0.15 * p.accel[i] : 0));
  return p;
}

const mean = (a, i, j) => { let s = 0; for (let k = i; k < j; k++) s += a[k]; return s / Math.max(1, j - i); };

function label(ride, a, b, p, cmax) {
  // the top-speed and max-HR clips are picked (and named) separately, so no "Top"/"Max" claims here
  const d = ride.d;
  const gm = mean(d.grade, a, b);
  if (gm > 3.5) return `Climbing ${Math.max(...d.grade.slice(a, b)).toFixed(0)}%`;
  if (gm < -3.5) return `Descent ${Math.min(...d.grade.slice(a, b)).toFixed(0)}%`;
  const c = { speed: mean(p.speed, a, b), hr: mean(p.hr, a, b), accel: mean(p.accel, a, b) };
  const best = Object.keys(c).reduce((x, y) => (c[y] > c[x] ? y : x));
  if (best === 'hr' && ride.has.hr) return `Heart rate ${mean(d.hr, a, b).toFixed(0)} bpm`;
  if (best === 'accel' && d.speed[b - 1] - d.speed[a] > 3) return 'Sprint';
  return `Cruising ${mean(d.speed, a, b).toFixed(0)} km/h`;
}

export function findHighlights(ride, clips, total = 60, clipLen = 6) {
  const p = score(ride), s = p.total, n = ride.n, L = Math.max(2, Math.round(clipLen));
  const cover = new Int32Array(n).fill(-1);
  clips.forEach((c, ci) => {
    if (c.startUtc == null) return;
    const a = Math.max(0, Math.ceil(c.startUtc - ride.t0) + 1), b = Math.min(n, Math.floor(c.startUtc + c.duration - ride.t0) - 1);
    for (let i = a; i < b; i++) cover[i] = ci;
  });
  let covered = 0; for (let i = 0; i < n; i++) if (cover[i] >= 0) covered++;
  if (covered < L) throw new Error('The videos do not overlap the ride data. Check the sync.');

  const valid = new Uint8Array(n), win = new Float64Array(n).fill(-1);
  let acc = 0; for (let i = 0; i < Math.min(L, n); i++) acc += s[i];
  for (let i = 0; i + L <= n; i++) {
    if (i) acc += s[i + L - 1] - s[i - 1];
    if (cover[i] >= 0 && cover[i] === cover[i + L - 1]) { valid[i] = 1; win[i] = acc; }
  }
  const cmax = { speed: 0, hr: 0 };
  for (let i = 0; i < n; i++) if (cover[i] >= 0) { cmax.speed = Math.max(cmax.speed, ride.d.speed[i]); if (Number.isFinite(ride.d.hr[i])) cmax.hr = Math.max(cmax.hr, ride.d.hr[i]); }

  const nClips = Math.max(1, Math.round(total / L)), sep = Math.max(L, Math.floor(covered / (nClips * 2.5)));
  const picks = [], taken = new Uint8Array(n);
  const take = (i, lab) => { picks.push([i, lab]); for (let k = Math.max(0, i - sep); k < Math.min(n, i + L + sep); k++) taken[k] = 1; };
  const peak = key => {
    let pi = -1, pv = -Infinity;
    for (let i = 0; i < n; i++) if (cover[i] >= 0 && Number.isFinite(ride.d[key][i]) && ride.d[key][i] > pv) { pv = ride.d[key][i]; pi = i; }
    let best = -1, bi = null;
    for (let i = Math.max(0, pi - L + 1); i <= pi; i++) if (valid[i] && !taken[i] && win[i] > best) { best = win[i]; bi = i; }
    return bi;
  };

  for (let i = 0; i < n; i++) if (cover[i] >= 0 && ride.d.moving[i] && valid[i]) { take(i, 'Rolling out'); break; }
  const must = [['speed', () => `Top speed ${cmax.speed.toFixed(0)} km/h`]];
  if (ride.has.hr) must.push(['hr', () => `Max heart rate ${cmax.hr.toFixed(0)} bpm`]);
  for (const [k, lab] of must) if (picks.length < nClips) { const i = peak(k); if (i != null) take(i, lab()); }
  while (picks.length < nClips) {
    let bi = -1, bv = 0;
    for (let i = 0; i < n; i++) if (!taken[i] && win[i] > bv) { bv = win[i]; bi = i; }
    if (bi < 0) break;
    take(bi, label(ride, bi, bi + L, p, cmax));
  }
  return picks.sort((a, b) => a[0] - b[0]).map(([i, lab]) => {
    const ci = cover[i], utc = ride.t0 + i;
    return { clip: ci, start: utc - clips[ci].startUtc, dur: L, utc, label: lab };
  });
}

/** whole clips in time order, trimmed on the joined timeline */
export function fullSegments(clips, trimStart = 0, trimEnd = null) {
  const order = clips.map((c, i) => i).filter(i => clips[i].startUtc != null).sort((a, b) => clips[a].startUtc - clips[b].startUtc);
  const end = trimEnd ?? order.reduce((a, i) => a + clips[i].duration, 0);
  const segs = []; let pos = 0;
  for (const i of order) {
    const c = clips[i], a = Math.max(trimStart - pos, 0), b = Math.min(end - pos, c.duration);
    if (b - a > 0.5) segs.push({ clip: i, start: a, dur: b - a, utc: c.startUtc + a, label: null });
    pos += c.duration;
  }
  return segs;
}
