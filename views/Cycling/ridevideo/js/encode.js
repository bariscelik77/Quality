// Frame-accurate renderer: WebCodecs (H.264 + AAC) → MP4 (mp4-muxer).
// Each source clip is decoded by us (mp4box index + VideoDecoder), frame by frame in order, and every
// output frame gets an exact 30 fps timestamp. Nothing depends on how the browser plays a <video>,
// so the output never freezes, drops frames or stretches, and a background tab only makes it slower.
// Ported from AsanaReel (theyoginim/video/js/encode.js) and extended for several clips per ride.
import { drawCamera, sourceCrop, loadFonts } from './overlay.js';
import { drawStamp } from './brand.js';

const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.mjs';
const MP4BOX_URL = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js';
const FPS = 30, TITLE_LEN = 3.5, TITLE_FADE = 0.8, FADE = 0.25;

export const canEncode = () => ['VideoEncoder', 'AudioEncoder', 'VideoDecoder', 'AudioDecoder', 'VideoFrame', 'AudioData'].every(k => k in window);

const abortErr = () => new DOMException('Cancelled', 'AbortError');
function loadScript(src) {
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res;
    s.onerror = () => rej(new Error(`Could not load ${src}`)); document.head.appendChild(s);
  });
}
// wait for a codec queue to shrink via 'dequeue' (not timers), so a background tab keeps full speed
const dequeued = codec => new Promise(r => ('ondequeue' in codec ? codec.addEventListener('dequeue', r, { once: true }) : setTimeout(r, 2)));

// ---------- read a file's index (mp4box): audio + video tracks ----------
export async function openTracks(file) {
  const out = { audio: null, video: null };
  try {
    await loadScript(MP4BOX_URL);
    const mp4 = window.MP4Box.createFile();
    mp4.discardMdatData = true; // only the index; sample bytes are read from the File directly
    let info = null, failed = false;
    mp4.onReady = i => (info = i);
    mp4.onError = () => (failed = true);
    let pos = 0;
    const CH = 1 << 20;
    while (!info && !failed && pos < file.size) {
      const buf = await file.slice(pos, pos + CH).arrayBuffer();
      buf.fileStart = pos;
      const next = mp4.appendBuffer(buf);
      pos = next > pos ? next : pos + CH; // mp4box skips over mdat when it can
    }
    if (!info) return out;

    const at = info.audioTracks?.[0];
    if (at) {
      const trak = mp4.getTrackById(at.id);
      let description;
      for (const e of trak.mdia.minf.stbl.stsd.entries) if (e.esds) description = e.esds.esd.descs[0].descs[0].data;
      const cfg = { codec: at.codec, sampleRate: at.audio.sample_rate, numberOfChannels: at.audio.channel_count, description };
      if ((await AudioDecoder.isConfigSupported(cfg).catch(() => ({}))).supported) out.audio = { cfg, samples: mp4.getTrackSamplesInfo(at.id) };
    }
    const vt = info.videoTracks?.[0];
    if (vt) {
      const trak = mp4.getTrackById(vt.id);
      const entry = trak.mdia.minf.stbl.stsd.entries[0];
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      let description;
      if (box) {
        const ds = new window.DataStream(undefined, 0, window.DataStream.BIG_ENDIAN);
        box.write(ds);
        description = new Uint8Array(ds.buffer, 8); // drop the 8-byte box header
      }
      const cfg = { codec: vt.codec, codedWidth: vt.video.width, codedHeight: vt.video.height, description, hardwareAcceleration: 'prefer-hardware' };
      const m = vt.matrix || [65536, 0, 0, 0, 65536, 0];
      const rotation = ((Math.round((Math.atan2(m[1], m[0]) * 180) / Math.PI / 90) * 90) % 360 + 360) % 360;
      let ok = (await VideoDecoder.isConfigSupported(cfg).catch(() => ({}))).supported;
      if (!ok) { delete cfg.hardwareAcceleration; ok = (await VideoDecoder.isConfigSupported(cfg).catch(() => ({}))).supported; }
      if (ok) out.video = { cfg, rotation, samples: mp4.getTrackSamplesInfo(vt.id) };
    }
  } catch (e) {
    console.warn('Could not read the file index', e);
  }
  return out;
}

/** Decoded frames of one track, in presentation order, starting at sample index `from`. */
function frameStream(file, track, from) {
  const S = track.samples, q = [];
  let idx = from, err = null, ended = false, flushing = false, waiter = null, pumping = false;
  const wake = () => { const w = waiter; waiter = null; w?.(); };
  const dec = new VideoDecoder({ output: f => { q.push(f); wake(); }, error: e => { err = e; wake(); } });
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try { while (!err && !flushing && q.length < 8 && dec.decodeQueueSize < 8) await feed(); }
    catch (e) { err = e; wake(); }
    finally { pumping = false; }
  };
  dec.addEventListener?.('dequeue', () => { pump(); wake(); });
  dec.configure(track.cfg);
  const feed = async () => {
    if (idx >= S.length) {
      if (!flushing) { flushing = true; dec.flush().then(() => { ended = true; wake(); }, e => { err = e; wake(); }); }
      return false;
    }
    let j = idx, end = S[idx].offset + S[idx].size;
    while (j + 1 < S.length && j - idx < 30 && S[j + 1].offset === end) { j++; end += S[j].size; }
    const buf = new Uint8Array(await file.slice(S[idx].offset, end).arrayBuffer());
    for (let k = idx; k <= j; k++) {
      const s = S[k], o = s.offset - S[idx].offset;
      dec.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round((s.cts / s.timescale) * 1e6), duration: Math.round((s.duration / s.timescale) * 1e6), data: buf.subarray(o, o + s.size) }));
    }
    idx = j + 1;
    return true;
  };
  return {
    async next() {
      pump();
      while (!q.length) {
        if (err) throw err;
        if (ended) return null;
        const w = new Promise(r => { waiter = r; });
        pump();
        await w;
      }
      const f = q.shift();
      pump();
      return f;
    },
    close() { q.splice(0).forEach(f => f.close()); try { dec.close(); } catch {} },
  };
}

/** Mixes source audio + looping music, applies gains/fade, feeds the AAC encoder in order. */
class Mixer {
  constructor(enc, rate, totalSec, music, musicGain) {
    Object.assign(this, { enc, rate, music, mg: musicGain });
    this.total = Math.round(totalSec * rate); this.cursor = 0; this.fade = Math.round(2.5 * rate);
  }
  push(start, L, R) {
    if (start >= this.total) return;
    if (start > this.cursor) this.silence(start - this.cursor);
    const skip = this.cursor - start;
    if (skip >= L.length) return;
    if (skip > 0) { L = L.subarray(skip); R = R.subarray(skip); }
    const n = Math.min(L.length, this.total - this.cursor);
    this.emit(L.subarray(0, n), R.subarray(0, n));
  }
  silence(n) {
    n = Math.min(n, this.total - this.cursor);
    for (let o = 0; o < n; o += 4096) { const z = new Float32Array(Math.min(4096, n - o)); this.emit(z, z); }
  }
  finish() { this.silence(this.total - this.cursor); }
  emit(L, R) {
    for (let o = 0; o < L.length; o += 4096) {
      const k = Math.min(4096, L.length - o), d = new Float32Array(2 * k);
      for (let i = 0; i < k; i++) {
        const f = this.cursor + i;
        let l = L[o + i], r = R[o + i];
        if (this.music) {
          const mi = f % this.music.len, left = this.total - f;
          const mg = left < this.fade ? (this.mg * left) / this.fade : f < this.rate ? (this.mg * f) / this.rate : this.mg;
          l += this.music.L[mi] * mg; r += this.music.R[mi] * mg;
        }
        d[i] = l > 1 ? 1 : l < -1 ? -1 : l;
        d[k + i] = r > 1 ? 1 : r < -1 ? -1 : r;
      }
      const ad = new AudioData({ format: 'f32-planar', sampleRate: this.rate, numberOfFrames: k, numberOfChannels: 2, timestamp: Math.round((this.cursor / this.rate) * 1e6), data: d });
      this.enc.encode(ad); ad.close();
      this.cursor += k;
    }
  }
}

/** camera sound of one segment → mixer at output offset `outOffset`, with gain and (highlights) fades */
async function decodeSegmentAudio(file, track, seg, outOffset, mixer, gain, fades, signal) {
  const a0 = seg.start - 0.25, a1 = seg.start + seg.dur + 0.25;
  const list = track.samples.filter(s => { const t = s.cts / s.timescale; return t >= a0 && t <= a1; });
  if (!list.length) return;
  let err = null;
  const env = t => { // t = seconds into the segment
    if (!fades) return gain;
    return gain * Math.max(0, Math.min(1, t / FADE, (seg.dur - t) / FADE));
  };
  const dec = new AudioDecoder({
    output: ad => {
      try {
        const ts = ad.timestamp / 1e6, sr = ad.sampleRate, n = ad.numberOfFrames;
        const a = Math.max(ts, seg.start), b = Math.min(ts + n / sr, seg.start + seg.dur);
        if (b > a) {
          const L = new Float32Array(n); ad.copyTo(L, { planeIndex: 0, format: 'f32-planar' });
          let R = L;
          if (ad.numberOfChannels > 1) { R = new Float32Array(n); ad.copyTo(R, { planeIndex: 1, format: 'f32-planar' }); }
          const i0 = Math.round((a - ts) * sr), i1 = Math.round((b - ts) * sr);
          const l = L.slice(i0, i1), r = R === L ? l.slice() : R.slice(i0, i1);
          for (let i = 0; i < l.length; i++) { const g = env(a - seg.start + i / sr); l[i] *= g; r[i] *= g; }
          mixer.push(Math.round((outOffset + a - seg.start) * mixer.rate), l, r);
        }
      } finally { ad.close(); }
    },
    error: e => (err = e),
  });
  dec.configure(track.cfg);
  let i = 0;
  while (i < list.length) {
    if (signal?.aborted) throw abortErr();
    if (err) throw err;
    let j = i, end = list[i].offset + list[i].size;
    while (j + 1 < list.length && list[j + 1].offset === end && end - list[i].offset < 2e6) { j++; end += list[j].size; }
    const buf = new Uint8Array(await file.slice(list[i].offset, end).arrayBuffer());
    for (let k = i; k <= j; k++) {
      const s = list[k], o = s.offset - list[i].offset;
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((s.cts / s.timescale) * 1e6), duration: Math.round((s.duration / s.timescale) * 1e6), data: buf.subarray(o, o + s.size) }));
    }
    i = j + 1;
    while (dec.decodeQueueSize > 64) await dequeued(dec);
  }
  await dec.flush();
  dec.close();
  if (err) throw err;
}

async function loadMusic(url, rate) {
  const buf = await (await fetch(url)).arrayBuffer();
  const ab = await new OfflineAudioContext(2, 1, rate).decodeAudioData(buf); // resampled to `rate`
  const L = ab.getChannelData(0), R = ab.numberOfChannels > 1 ? ab.getChannelData(1) : L;
  return { L, R, len: ab.length };
}

/** index (mp4box) of each clip used by the segments; null if any can't be decoded directly */
export async function prepareTracks(clips, segments) {
  const map = new Map();
  for (const s of segments) {
    if (map.has(s.clip)) continue;
    const t = await openTracks(clips[s.clip].file);
    if (!t.video) return null;
    map.set(s.clip, t);
  }
  return map;
}

/**
 * job = { clips, segments, tracks (from prepareTracks), overlay, summary, stampMode, stampBox, highlights,
 *         showTitle, musicUrl, musicVol, camVol, writable?, signal, onProgress(p, note) }
 */
export async function encodeVideo(job) {
  const L = job.overlay.L, { W, H } = L, { signal } = job;
  const segs = job.segments, total = segs.reduce((a, s) => a + s.dur, 0);
  const bitrate = Math.max(W, H) >= 1900 ? 12_000_000 : 8_000_000;
  const report = (p, note) => job.onProgress?.(Math.max(0, Math.min(1, p)), note);

  report(0, 'Preparing…');
  const [{ Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget }] = await Promise.all([import(MUXER_URL), loadFonts()]);

  // ----- audio setup -----
  const firstAudio = [...job.tracks.values()].find(t => t.audio)?.audio;
  let rate = firstAudio?.cfg.sampleRate || 48000;
  const aCfg = r => ({ codec: 'mp4a.40.2', sampleRate: r, numberOfChannels: 2, bitrate: 192_000 });
  if (!(await AudioEncoder.isConfigSupported(aCfg(rate))).supported) rate = 48000;
  const music = job.musicUrl && job.musicVol > 0 ? await loadMusic(job.musicUrl, rate).catch(e => { console.warn('music failed', e); return null; }) : null;

  const target = job.writable ? new FileSystemWritableFileStreamTarget(job.writable) : new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: W, height: H, frameRate: FPS },
    audio: { codec: 'aac', numberOfChannels: 2, sampleRate: rate },
    fastStart: job.writable ? false : 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let encErr = null;
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => (encErr = e) });
  aenc.configure(aCfg(rate));
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => (encErr = e) });
  const vCfg = { codec: 'avc1.640028', width: W, height: H, bitrate, framerate: FPS, latencyMode: 'quality', avc: { format: 'avc' } };
  if (!(await VideoEncoder.isConfigSupported(vCfg)).supported) vCfg.codec = 'avc1.4d0028';
  venc.configure(vCfg);

  // ----- audio pass (fast, decoding only) -----
  report(0, 'Preparing sound…');
  const mixer = new Mixer(aenc, rate, total, music, job.musicVol);
  if (job.camVol > 0) {
    let off = 0;
    for (const s of segs) {
      const tr = job.tracks.get(s.clip).audio;
      if (tr && tr.cfg.sampleRate === rate) await decodeSegmentAudio(job.clips[s.clip].file, tr, s, off, mixer, job.camVol, job.highlights, signal);
      off += s.dur;
    }
  }
  mixer.finish();
  await aenc.flush();
  if (encErr) throw encErr;

  // ----- video pass -----
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const frameCanvas = document.createElement('canvas'), fctx = frameCanvas.getContext('2d');
  const putFrame = (f, rot) => {
    const w = f.displayWidth, h = f.displayHeight, side = rot === 90 || rot === 270;
    const cw = side ? h : w, ch = side ? w : h;
    if (frameCanvas.width !== cw || frameCanvas.height !== ch) { frameCanvas.width = cw; frameCanvas.height = ch; }
    fctx.save();
    if (rot === 90) { fctx.translate(cw, 0); fctx.rotate(Math.PI / 2); }
    else if (rot === 180) { fctx.translate(cw, ch); fctx.rotate(Math.PI); }
    else if (rot === 270) { fctx.translate(0, ch); fctx.rotate(-Math.PI / 2); }
    fctx.drawImage(f, 0, 0, w, h);
    fctx.restore();
  };

  let lastTs = -1, lastKey = -10;
  const t0 = performance.now();
  const emit = async outT => {
    const ts = Math.round(outT * 1e6);
    if (ts <= lastTs) return;
    while (venc.encodeQueueSize > 8) await dequeued(venc); // let the encoder catch up; never drop frames
    const frame = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1e6 / FPS) });
    const key = outT - lastKey >= 2;
    if (key) lastKey = outT;
    venc.encode(frame, { keyFrame: key });
    frame.close();
    lastTs = ts;
    const el = (performance.now() - t0) / 1000, p = outT / total;
    report(p, p > 0.02 ? `${(outT / el).toFixed(1)}× real time · ${fmtLeft(el / p - el)} left` : 'starting…');
  };

  try {
    let off = 0;
    for (const seg of segs) {
      const clip = job.clips[seg.clip], vt = job.tracks.get(seg.clip).video, S = vt.samples;
      const tsOf = s => s.cts / s.timescale;
      let from = 0; // last key frame at or before the segment start
      for (let i = 0; i < S.length; i++) { if (S[i].is_sync && tsOf(S[i]) <= seg.start + 1e-3) from = i; if (tsOf(S[i]) > seg.start + 5) break; }
      const fs = frameStream(clip.file, vt, from);
      let crop = null;
      try {
        let cur = null, nxt = await fs.next();
        const n = Math.max(1, Math.round(seg.dur * FPS));
        for (let k = 0; k < n; k++) {
          if (signal?.aborted) throw abortErr();
          if (encErr) throw encErr;
          const want = seg.start + k / FPS, outT = off + k / FPS;
          while (nxt && nxt.timestamp / 1e6 <= want + 0.5 / FPS) { cur?.close(); cur = nxt; nxt = await fs.next(); }
          const f = cur || nxt;
          if (f) { putFrame(f, vt.rotation); if (!crop) crop = sourceCrop(frameCanvas.width, frameCanvas.height, job.stampMode, job.stampBox); }
          if (crop) drawCamera(ctx, frameCanvas, L, crop);
          job.overlay.draw(ctx, clip.startUtc + want, seg.label);
          if (job.brand) drawStamp(ctx, W, H);
          if (job.showTitle && outT < TITLE_LEN + TITLE_FADE) job.overlay.drawTitle(ctx, job.summary, outT < TITLE_LEN ? 1 : 1 - (outT - TITLE_LEN) / TITLE_FADE);
          if (job.highlights) {
            const t = k / FPS, a = Math.max(0, 1 - t / FADE, 1 - (seg.dur - t) / FADE);
            if (a > 0) { ctx.fillStyle = `rgba(0,0,0,${Math.min(1, a)})`; ctx.fillRect(0, 0, W, H); }
          }
          await emit(outT);
        }
        cur?.close(); nxt?.close();
      } finally { fs.close(); }
      off += seg.dur;
    }
    report(1, 'Finishing…');
    await venc.flush();
    if (encErr) throw encErr;
    muxer.finalize();
  } finally {
    if (venc.state !== 'closed') venc.close();
    if (aenc.state !== 'closed') aenc.close();
  }

  if (job.writable) { await job.writable.close(); return { saved: true, mime: 'video/mp4', ext: 'mp4' }; }
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), mime: 'video/mp4', ext: 'mp4' };
}

function fmtLeft(s) { return !Number.isFinite(s) ? '…' : s > 90 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`; }
