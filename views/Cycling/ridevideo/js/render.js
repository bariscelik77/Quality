// Renders the finished video in the browser: canvas compositing + Web Audio mix + MediaRecorder.
// Real time: a 60 s reel takes about 60 s; a 50 min ride takes about 50 min (keep the tab in front).
// Adapted from AsanaReel (theyoginim/video/js/render.js), including its stall watchdog.
import { drawCamera, sourceCrop, loadFonts } from './overlay.js';

const TITLE_LEN = 3.5, TITLE_FADE = 0.8, FADE = 0.25;

export function pickMime() {
  const c = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

const once = (el, ev) => new Promise((res, rej) => {
  const ok = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); res(); };
  const bad = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); rej(new Error(`Media error while waiting for ${ev}`)); };
  el.addEventListener(ev, ok); el.addEventListener('error', bad);
});

/**
 * job = { clips, segments, overlay (Overlay), summary, stampMode, stampBox, highlights:bool, showTitle,
 *         musicUrl, musicVol, camVol, writable?, signal, onProgress }
 */
export async function renderVideo(job) {
  const ac = new AudioContext(); // created inside the click
  const L = job.overlay.L, { W, H } = L;
  await loadFonts();

  const v = document.createElement('video');
  v.playsInline = true; v.preload = 'auto'; v.hidden = true;
  document.body.appendChild(v);

  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const dest = ac.createMediaStreamDestination();
  const gCam = ac.createGain(); gCam.gain.value = job.highlights ? 0 : job.camVol;
  ac.createMediaElementSource(v).connect(gCam).connect(dest);
  let music = null, gM = null;
  if (job.musicUrl && job.musicVol > 0) {
    music = new Audio(job.musicUrl); music.loop = true;
    gM = ac.createGain(); gM.gain.value = 0;
    ac.createMediaElementSource(music).connect(gM).connect(dest);
    await once(music, 'canplay').catch(() => { music = null; });
  }
  await ac.resume();

  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = pickMime();
  const bitrate = H >= 1080 || W >= 1080 ? 12_000_000 : 8_000_000;
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192_000 });
  const chunks = [];
  let writeChain = Promise.resolve();
  rec.ondataavailable = e => {
    if (!e.data.size) return;
    if (job.writable) writeChain = writeChain.then(() => job.writable.write(e.data));
    else chunks.push(e.data);
  };
  const stopped = new Promise(r => (rec.onstop = r));

  const segs = job.segments, total = segs.reduce((a, s) => a + s.dur, 0);
  let done = 0, seg = null, clip = null, crop = null, alive = true, srcIdx = -1, musicFading = false;

  const draw = () => {
    if (!alive) return;
    if (seg && v.readyState >= 2) {
      const t = v.currentTime, local = Math.max(0, t - seg.start), outT = done + local;
      drawCamera(ctx, v, L, crop);
      job.overlay.draw(ctx, clip.startUtc + t, seg.label);
      if (job.showTitle && outT < TITLE_LEN + TITLE_FADE) job.overlay.drawTitle(ctx, job.summary, outT < TITLE_LEN ? 1 : 1 - (outT - TITLE_LEN) / TITLE_FADE);
      if (job.highlights) {
        const a = Math.max(0, 1 - local / FADE, 1 - (seg.dur - local) / FADE);
        if (a > 0) { ctx.fillStyle = `rgba(0,0,0,${Math.min(1, a)})`; ctx.fillRect(0, 0, W, H); }
      }
      if (gM && !musicFading && total - outT < 2.5) { musicFading = true; gM.gain.setTargetAtTime(0, ac.currentTime, 0.7); }
      job.onProgress?.(Math.min(1, outT / total));
    }
    requestAnimationFrame(draw);
  };

  const abortErr = () => new DOMException('Cancelled', 'AbortError');
  try {
    for (let i = 0; i < segs.length; i++) {
      if (job.signal?.aborted) throw abortErr();
      const s = segs[i], c = job.clips[s.clip];
      if (rec.state === 'recording') rec.pause();
      music?.pause();
      if (srcIdx !== s.clip) { v.src = c.url; srcIdx = s.clip; await once(v, 'loadedmetadata'); }
      v.currentTime = s.start;
      await once(v, 'seeked');
      seg = s; clip = c; crop = sourceCrop(v.videoWidth, v.videoHeight, job.stampMode, job.stampBox);
      if (i === 0) {
        requestAnimationFrame(draw); await new Promise(r => setTimeout(r, 120)); rec.start(1000);
        if (gM) gM.gain.setTargetAtTime(job.musicVol, ac.currentTime, 0.5);
      } else rec.resume();
      if (job.highlights) {
        gCam.gain.cancelScheduledValues(ac.currentTime);
        gCam.gain.setValueAtTime(0, ac.currentTime);
        gCam.gain.linearRampToValueAtTime(job.camVol, ac.currentTime + FADE);
        gCam.gain.setValueAtTime(job.camVol, ac.currentTime + Math.max(FADE, s.dur - FADE));
        gCam.gain.linearRampToValueAtTime(0, ac.currentTime + s.dur);
      }
      if (music) music.play().catch(() => {});
      await v.play();
      await new Promise((res, rej) => {
        let finished = false, lastT = -1, lastMove = performance.now(), recovering = false;
        const end = err => { if (finished) return; finished = true; clearInterval(iv); v.removeEventListener('ended', onEnd); err ? rej(err) : res(); };
        // Chrome can leave a fully-buffered video stuck in 'waiting'; a tiny seek un-sticks it (recorder paused meanwhile)
        const recover = async () => {
          recovering = true;
          if (rec.state === 'recording') rec.pause();
          music?.pause();
          v.currentTime = Math.min(v.currentTime + 0.02, v.duration - 0.05);
          await once(v, 'seeked').catch(() => {});
          if (rec.state === 'paused') rec.resume();
          music?.play().catch(() => {});
          await v.play().catch(() => {});
          lastMove = performance.now(); recovering = false;
        };
        const check = () => {
          if (finished || recovering) return;
          if (job.signal?.aborted) return end(abortErr());
          if (v.currentTime >= s.start + s.dur - 0.02 || v.ended) return end();
          if (v.currentTime !== lastT) { lastT = v.currentTime; lastMove = performance.now(); }
          else if (!v.paused && performance.now() - lastMove > 700) recover();
        };
        const onEnd = () => end();
        const tick = () => { check(); if (!finished && v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick); };
        const iv = setInterval(check, 100);
        v.addEventListener('ended', onEnd);
        tick();
      });
      v.pause();
      done += s.dur;
    }
    if (gM) { gM.gain.setTargetAtTime(0, ac.currentTime, 0.2); await new Promise(r => setTimeout(r, 400)); }
    rec.stop();
    await stopped;
  } catch (e) {
    if (rec.state !== 'inactive') { rec.stop(); await stopped; }
    throw e;
  } finally {
    alive = false;
    v.pause(); music?.pause();
    v.removeAttribute('src'); v.load(); v.remove();
    ac.close();
  }

  await writeChain;
  if (job.writable) { await job.writable.close(); return { saved: true, mime }; }
  const type = (mime || 'video/webm').split(';')[0];
  return { blob: new Blob(chunks, { type }), mime: type, ext: type.includes('mp4') ? 'mp4' : 'webm' };
}
