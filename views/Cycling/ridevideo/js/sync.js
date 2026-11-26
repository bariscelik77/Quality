// Clip probing and clock sync. The camera burns its local date/time into the picture
// (bottom-right on SJCAM). We read it with Tesseract.js at a few points per clip,
// then pick the time zone that makes the clips overlap the (UTC) ride file.

export const STAMP_BOX = [0.665, 0.915, 0.325, 0.075]; // x, y, w, h as fractions of the frame
const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const STAMP_RE = /(20\d\d)\D?([01]\d)\D?([0-3]\d)\D*([0-2]\d)\D?([0-5]\d)\D?([0-5]\d)/;
const NAME_RE = /(20\d\d)[_-]?([01]\d)([0-3]\d)[_-]?([0-2]\d)([0-5]\d)([0-5]\d)/;

const once = (el, ev) => new Promise((res, rej) => {
  const ok = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); res(); };
  const bad = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); rej(new Error('This video could not be read by the browser.')); };
  el.addEventListener(ev, ok); el.addEventListener('error', bad);
});

/** "camera clock" times are kept as naive seconds: Date.UTC of the wall-clock reading */
const naive = (y, mo, d, h, mi, s) => Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) / 1000;
export const fmtNaive = s => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 19);
export const parseNaive = str => {
  const m = String(str).trim().match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)$/);
  return m ? naive(...m.slice(1)) : null;
};

export async function probe(file) {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.playsInline = true;
  v.src = URL.createObjectURL(file);
  await once(v, 'loadedmetadata');
  if (!v.videoWidth) await once(v, 'loadeddata');
  return { file, name: file.name, url: v.src, el: v, duration: v.duration, width: v.videoWidth, height: v.videoHeight,
           startLocal: null, source: '', startUtc: null };
}

let workerP = null;
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load the text reader (Tesseract.js). Check your internet connection.')); document.head.appendChild(s); });
}
async function ocrWorker() {
  if (!workerP) workerP = (async () => {
    if (!window.Tesseract) await loadScript(TESS);
    const w = await window.Tesseract.createWorker('eng');
    await w.setParameters({ tessedit_char_whitelist: '0123456789/:-', tessedit_pageseg_mode: '7' });
    return w;
  })();
  return workerP;
}

async function readStampAt(clip, t, box, worker) {
  const v = clip.el;
  v.currentTime = Math.min(Math.max(t, 0), clip.duration - 0.05);
  await once(v, 'seeked');
  const [x, y, w, h] = box;
  const sx = Math.round(clip.width * x), sy = Math.round(clip.height * y);
  const sw = Math.min(clip.width - sx, Math.round(clip.width * w)), sh = Math.min(clip.height - sy, Math.round(clip.height * h));
  const c = document.createElement('canvas'); c.width = sw * 3; c.height = sh * 3;
  const g = c.getContext('2d', { willReadFrequently: true });
  for (const thr of [200, 170, 225, 140]) {
    g.drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const img = g.getImageData(0, 0, c.width, c.height), p = img.data;
    for (let i = 0; i < p.length; i += 4) {
      const l = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2], o = l > thr ? 0 : 255; // dark text on white
      p[i] = p[i + 1] = p[i + 2] = o;
    }
    g.putImageData(img, 0, 0);
    const { data } = await worker.recognize(c);
    const m = data.text.replace(/\s/g, '').match(STAMP_RE);
    if (m) { const s = naive(...m.slice(1)); if (Number.isFinite(s)) return s; }
  }
  return null;
}

/** fills clip.startLocal (naive seconds of the first frame) */
export async function detectStart(clip, box = STAMP_BOX, onStep = () => {}) {
  const d = clip.duration, N = 5;
  const times = [Math.min(1, d / 2), ...Array.from({ length: N - 2 }, (_, k) => (d * (k + 1)) / (N - 1)), Math.max(d - 2, 0)];
  const starts = [];
  try {
    const worker = await ocrWorker();
    for (let i = 0; i < times.length; i++) {
      onStep(i / times.length);
      const s = await readStampAt(clip, times[i], box, worker).catch(() => null);
      if (s != null) starts.push(s + 0.5 - times[i]);
    }
  } catch (e) { console.warn(e); }
  if (starts.length) {
    const med = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
    const m = med(starts), good = starts.filter(s => Math.abs(s - m) < 5);
    clip.startLocal = med(good); clip.source = `stamp (${good.length}/${times.length})`;
    return clip;
  }
  const n = clip.name.match(NAME_RE);
  if (n) { clip.startLocal = naive(...n.slice(1)); clip.source = 'file name'; return clip; }
  clip.source = 'not found';
  return clip;
}

export function guessTz(clips, t0, t1, preferred) {
  const dated = clips.filter(c => c.startLocal != null);
  if (!dated.length) return preferred;
  const cands = Array.from({ length: 53 }, (_, k) => (k - 24) / 2).sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred));
  let best = preferred, bestScore = -1;
  for (const tz of cands) {
    let score = 0;
    for (const c of dated) { const s = c.startLocal - tz * 3600; score += Math.max(0, Math.min(s + c.duration, t1) - Math.max(s, t0)); }
    if (score > bestScore + 1e-6) { best = tz; bestScore = score; }
  }
  return bestScore > 0 ? best : preferred;
}

export function applySync(clips, tz, offset = 0) {
  for (const c of clips) c.startUtc = c.startLocal == null ? null : c.startLocal - tz * 3600 + offset;
}
