// Sports, data items and preset layouts (same as the desktop app's fields.py).
// Choosing your own dashboard comes in a later version; for now each sport has a preset.

export const SPORTS = {
  cycling: ['Cycling', 'Bisiklet'], running: ['Running', 'Koşu'], walking: ['Walking / hiking', 'Yürüyüş / doğa yürüyüşü'],
  skiing: ['Skiing / snowboard', 'Kayak / snowboard'], other: ['Other', 'Diğer'],
};

// key: [label on video, needs this channel or null]
export const FIELDS = {
  hr: ['BPM', 'hr'], speed: ['SPEED', null], pace: ['PACE', null], dist: ['DIST', null], elev: ['ELEV', 'ele'],
  grade: ['SLOPE', 'ele'], time: ['TIME', null], power: ['POWER', 'power'], cad: ['CADENCE', 'cad'], temp: ['TEMP', 'temp'],
};

const PRESETS = {
  cycling: { big: ['hr', 'speed'], small: ['dist', 'elev', 'grade', 'time', 'power', 'cad'] },
  running: { big: ['hr', 'pace'], small: ['dist', 'elev', 'cad', 'time', 'grade', 'temp'] },
  walking: { big: ['hr', 'dist'], small: ['pace', 'elev', 'grade', 'time', 'temp'] },
  skiing: { big: ['speed', 'hr'], small: ['elev', 'grade', 'dist', 'time', 'temp'] },
  other: { big: ['hr', 'speed'], small: ['dist', 'elev', 'time'] },
};

/** GPX <type>, TCX Sport="", FIT sport → one of SPORTS */
export function detectSport(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('run')) return 'running';
  if (t.includes('walk') || t.includes('hik')) return 'walking';
  if (t.includes('ski') || t.includes('snow')) return 'skiing';
  if (t.includes('cycl') || t.includes('bik') || t.includes('ride')) return 'cycling';
  return t ? 'other' : 'cycling';
}

export const available = has => Object.keys(FIELDS).filter(k => !FIELDS[k][1] || has[FIELDS[k][1]]);

export function presetStyle(sport, has) {
  const av = available(has), p = PRESETS[sport] || PRESETS.other;
  let big = p.big.filter(k => av.includes(k));
  if (!big.length) big = ['speed'];
  return { sport, big: big.slice(0, 2), small: p.small.filter(k => av.includes(k) && !big.includes(k)), map: true, profile: true };
}

export const fmtPace = kmh => {
  if (!(kmh >= 1)) return '--:--';
  const s = 3600 / kmh;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const fmtT = sec => {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/** [value text, unit] for field key at sample v */
export function fieldValue(key, v, t0, cadMul = 1) {
  const n = x => Number.isFinite(x);
  switch (key) {
    case 'hr': return [n(v.hr) ? v.hr.toFixed(0) : '--', 'BPM'];
    case 'speed': return [v.speed.toFixed(0), 'KM/H'];
    case 'pace': return [fmtPace(v.speed), '/KM'];
    case 'dist': return [(v.dist / 1000).toFixed(2), 'KM'];
    case 'elev': return [v.ele.toFixed(0), 'M'];
    case 'grade': return [Math.abs(v.grade) >= 0.5 ? (v.grade > 0 ? '+' : '') + v.grade.toFixed(0) : '0', '%'];
    case 'time': return [fmtT(v.t - t0), ''];
    case 'power': return [n(v.power) ? v.power.toFixed(0) : '--', 'W'];
    case 'cad': return [n(v.cad) ? (v.cad * cadMul).toFixed(0) : '--', cadMul > 1 ? 'SPM' : 'RPM'];
    case 'temp': return [n(v.temp) ? v.temp.toFixed(0) : '--', '°C'];
  }
  return ['', ''];
}

/** running/walking cadence is often stored per leg (e.g. 85): show steps per minute */
export function cadenceMultiplier(sport, cad) {
  if (sport !== 'running' && sport !== 'walking') return 1;
  const v = [...cad].filter(x => x > 0).sort((a, b) => a - b);
  return v.length && v[Math.floor(v.length / 2)] < 120 ? 2 : 1;
}
