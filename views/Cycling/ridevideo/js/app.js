// RideVideo (web) — main UI.
import { loadRideFile } from './telemetry.js';
import { probe, detectStart, guessTz, applySync, STAMP_BOX, fmtNaive, parseNaive } from './sync.js';
import { Overlay, makeLayout, sourceCrop, drawCamera, loadFonts, fmtTime } from './overlay.js';
import { findHighlights, fullSegments } from './highlights.js';
import { renderVideo, pickMime } from './render.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const L = (en, tr) => (window.I18N ? window.I18N.L(en, tr) : en);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = t => fmtTime(t).replace(/^0(\d:)/, '$1');
const parseTime = s => { const p = String(s).trim().split(':').map(Number); return !s || p.some(n => !Number.isFinite(n)) ? null : p.reduce((a, b) => a * 60 + b, 0); };
let toastT;
const toast = (m, ms = 3500) => { const el = $('#toast'); el.textContent = m; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), ms); };

// ---------- settings ----------
const DEF = { kind: 'landscape', mode: 'highlights', hlLen: 60, hlClip: 5, tz: 3, maxHr: 185, stamp: 'zoom', musicVol: 0.7, camVol: 0.4, showTitle: true };
let S = { ...DEF };
try { S = { ...DEF, ...JSON.parse(localStorage.getItem('ridevideo') || '{}') }; } catch {}
const save = () => { try { localStorage.setItem('ridevideo', JSON.stringify(S)); } catch {} };

// ---------- state ----------
const st = { clips: [], ride: null, rideFile: '', tz: S.tz, offset: 0, cur: 0, overlay: null, layout: null, segs: [], music: null, rendering: null, busy: false };
const v = $('#srcVideo'), canvas = $('#preview'), ctx = canvas.getContext('2d');

// ---------- files ----------
async function addFiles(files) {
  const vids = [...files].filter(f => f.type.startsWith('video/') || /\.(mp4|mov|mkv|avi)$/i.test(f.name));
  const gpx = [...files].find(f => /\.gpx$/i.test(f.name));
  if (gpx) {
    try { st.ride = await loadRideFile(gpx); st.rideFile = gpx.name; if (!$('#titleIn').value) $('#titleIn').value = st.ride.name; }
    catch (e) { toast(e.message, 6000); }
  }
  for (const f of vids) {
    if (st.clips.some(c => c.name === f.name && c.file.size === f.size)) continue;
    try { st.clips.push(await probe(f)); } catch (e) { toast(`${f.name}: ${e.message}`, 6000); }
  }
  refreshFiles();
  await detectAll();
  autoSync();
  showViewer();
}

async function detectAll() {
  const todo = st.clips.filter(c => c.startLocal == null && !c.tried);
  if (!todo.length) return;
  const prog = $('#syncProg'), bar = prog.querySelector('.bar'), lbl = prog.querySelector('.lbl');
  prog.hidden = false; st.busy = true;
  for (let k = 0; k < todo.length; k++) {
    const c = todo[k];
    await detectStart(c, STAMP_BOX, f => {
      bar.style.width = `${((k + f) / todo.length) * 100}%`;
      lbl.textContent = L(`Reading the camera clock: ${c.name}`, `Kamera saati okunuyor: ${c.name}`);
    });
    c.tried = true;
  }
  prog.hidden = true; st.busy = false;
  st.clips.sort((a, b) => (a.startLocal ?? 9e12) - (b.startLocal ?? 9e12));
}

function autoSync() {
  if (st.ride && st.clips.some(c => c.startLocal != null)) {
    st.tz = guessTz(st.clips, st.ride.t0, st.ride.t1, +S.tz);
    S.tz = st.tz; save();
  }
  resync();
}

function resync() {
  applySync(st.clips, st.tz, st.offset);
  $('#tzIn').value = st.tz; $('#offIn').value = st.offset; $('#offLbl').textContent = `${st.offset.toFixed(1)} s`;
  refreshSync(); rebuildOverlay(); refreshHighlights();
}

function refreshFiles() {
  const rows = st.clips.map(c => `<li><span class="k">${L('VIDEO', 'VİDEO')}</span><span class="nm" title="${esc(c.name)}">${esc(c.name)}</span><span class="meta">${fmt(c.duration)} · ${c.width}×${c.height}</span></li>`);
  if (st.ride) rows.unshift(`<li><span class="k gpx">GPX</span><span class="nm">${esc(st.rideFile)}</span><span class="meta">${st.ride.has.hr ? L('with heart rate', 'nabız var') : L('no heart rate', 'nabız yok')}</span></li>`);
  $('#fileList').innerHTML = rows.join('');
  const s = st.ride?.summary();
  $('#stats').hidden = !s;
  if (s) $('#stats').innerHTML = [
    [L('Distance', 'Mesafe'), `${s.km.toFixed(1)} km`], [L('Moving', 'Hareket'), fmtTime(s.moving)], [L('Climb', 'Tırmanış'), `${s.gain.toFixed(0)} m`],
    [L('Avg speed', 'Ort. hız'), `${s.avgSpeed.toFixed(1)} km/h`], [L('Avg HR', 'Ort. nabız'), s.avgHr ? `${s.avgHr.toFixed(0)} bpm` : '–'], [L('Max HR', 'Maks. nabız'), s.maxHr ? `${s.maxHr.toFixed(0)} bpm` : '–'],
  ].map(([k, val]) => `<div><small>${k}</small><b>${val}</b></div>`).join('');
  $('#syncCard').hidden = !(st.ride && st.clips.length);
  $('#outCard').hidden = $('#syncCard').hidden;
  const sel = $('#clipSel');
  sel.hidden = st.clips.length < 2;
  sel.innerHTML = st.clips.map((c, i) => `<option value="${i}">${esc(c.name)}</option>`).join('');
  sel.value = String(st.cur);
}

function refreshSync() {
  if (!st.ride) return;
  const head = `<tr><th>${L('Video', 'Video')}</th><th>${L('Camera start', 'Kamera başlangıcı')}</th><th>${L('Covered', 'Kapsanan')}</th></tr>`;
  $('#clipTable').innerHTML = head + st.clips.map((c, i) => {
    let cov = '–';
    if (c.startUtc != null) { const o = Math.max(0, Math.min(c.startUtc + c.duration, st.ride.t1) - Math.max(c.startUtc, st.ride.t0)); cov = `${Math.round((o / c.duration) * 100)}%`; }
    const ok = c.startLocal != null;
    return `<tr><td>${esc(c.name)}</td><td>${ok ? `${fmtNaive(c.startLocal)}<br><span class="ok">${esc(c.source)}</span>`
      : `<input data-man="${i}" placeholder="2026-01-31 08:00:00"><span class="warn">${L('Stamp not found: type the start time', 'Damga okunamadı: başlangıç saatini yazın')}</span>`}</td><td>${cov}</td></tr>`;
  }).join('');
  $$('[data-man]').forEach(inp => inp.addEventListener('change', () => {
    const s = parseNaive(inp.value);
    if (s == null) return toast(L('Use YYYY-MM-DD HH:MM:SS', 'Biçim: YYYY-AA-GG SS:DD:ss'));
    const c = st.clips[+inp.dataset.man]; c.startLocal = s; c.source = L('typed', 'elle'); autoSync();
  }));
}

// ---------- overlay + preview ----------
function rebuildOverlay() {
  const c = st.clips[st.cur];
  if (!c) return;
  const [, , cw, ch] = sourceCrop(c.width, c.height, S.stamp, STAMP_BOX);
  st.layout = makeLayout(S.kind, cw, ch);
  canvas.width = st.layout.W; canvas.height = st.layout.H;
  st.overlay = st.ride ? new Overlay(st.ride, st.layout, { maxHr: +S.maxHr, title: $('#titleIn').value, tzHours: st.tz }) : null;
}

function showViewer() {
  if (!st.clips.length) return;
  $('#drop').hidden = true; $('#viewer').hidden = false;
  selectClip(st.cur);
}

function selectClip(i, t = null) {
  st.cur = i; $('#clipSel').value = String(i);
  const c = st.clips[i];
  if (v.src !== c.url) { v.src = c.url; v.addEventListener('loadedmetadata', () => { v.currentTime = t ?? Math.min(c.duration / 2, 300); }, { once: true }); }
  else if (t != null) v.currentTime = t;
  rebuildOverlay();
}

function loop() {
  const c = st.clips[st.cur];
  if (c && st.layout && v.readyState >= 2) {
    const crop = sourceCrop(v.videoWidth, v.videoHeight, S.stamp, STAMP_BOX);
    drawCamera(ctx, v, st.layout, crop);
    if (st.overlay && c.startUtc != null) {
      const t = c.startUtc + v.currentTime, seg = st.segs.find(s => s.clip === st.cur && v.currentTime >= s.start && v.currentTime < s.start + s.dur);
      st.overlay.draw(ctx, t, S.mode === 'highlights' ? seg?.label : null);
      const inRide = t >= st.ride.t0 && t <= st.ride.t1;
      $('#nowLbl').innerHTML = inRide ? L(`Ride time <b>${fmtTime(t - st.ride.t0)}</b> · check that speed and heart rate match the picture`, `Sürüş zamanı <b>${fmtTime(t - st.ride.t0)}</b> · hız ve nabzın görüntüyle uyuştuğunu kontrol edin`)
        : L('This moment is outside the ride data.', 'Bu an sürüş verisinin dışında.');
    } else $('#nowLbl').textContent = st.ride ? L('Waiting for the clock stamp…', 'Saat damgası bekleniyor…') : L('Add the GPX file of this ride.', 'Bu sürüşün GPX dosyasını ekleyin.');
    $('#timeLbl').textContent = `${fmt(v.currentTime)} / ${fmt(c.duration)}`;
    if (!scrubbing) $('#scrub').value = String(Math.round((v.currentTime / c.duration) * 1000));
  }
  requestAnimationFrame(loop);
}
let scrubbing = false;

// ---------- highlights ----------
function refreshHighlights() {
  const list = $('#hlList');
  st.segs = [];
  if (!st.ride || !st.clips.some(c => c.startUtc != null)) { list.innerHTML = ''; return; }
  try {
    st.segs = findHighlights(st.ride, st.clips, +S.hlLen, +S.hlClip);
    list.innerHTML = st.segs.map((s, i) => `<li data-i="${i}"><span class="at">${fmtTime(s.utc - st.ride.t0)}</span>${esc(trLabel(s.label))}</li>`).join('');
  } catch (e) { list.innerHTML = `<li class="warn">${esc(e.message)}</li>`; }
}
const trLabel = s => (window.I18N?.lang === 'tr' ? s.replace('Rolling out', 'Yola çıkış').replace('Top speed', 'En yüksek hız').replace('Max heart rate', 'En yüksek nabız')
  .replace('Heart rate', 'Nabız').replace('Climbing', 'Tırmanış').replace('Descent', 'İniş').replace('Sprint', 'Sprint').replace('Cruising', 'Seyir') : s);

function orderedClips() { return st.clips.map((c, i) => i).filter(i => st.clips[i].startUtc != null).sort((a, b) => st.clips[a].startUtc - st.clips[b].startUtc); }
function joinedNow() {
  let pos = 0;
  for (const i of orderedClips()) { if (i === st.cur) return pos + v.currentTime; pos += st.clips[i].duration; }
  return v.currentTime;
}

// ---------- render ----------
async function doRender() {
  if (st.rendering) return;
  if (!window.MediaRecorder) return toast(L('This browser cannot record video. Use Chrome or Edge on a computer.', 'Bu tarayıcı video kaydedemiyor. Bilgisayarda Chrome veya Edge kullanın.'), 6000);
  let segs;
  if (S.mode === 'highlights') segs = st.segs;
  else {
    const a = parseTime($('#trimA').value) ?? 0, b = parseTime($('#trimB').value);
    segs = fullSegments(st.clips, a, b);
  }
  if (!segs?.length) return toast(L('Nothing to render: check the sync.', 'Oluşturulacak bir şey yok: senkronizasyonu kontrol edin.'));
  v.pause();
  const mime = pickMime(), ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const s = st.ride.summary(), d = new Date((s.start.getTime() / 1000 + st.tz * 3600) * 1000).toISOString().slice(0, 10);
  const slug = ($('#titleIn').value || 'ride').replace(/[^\w-]+/g, '_').slice(0, 40);
  const name = `${d}_${slug}_${S.mode}_${S.kind === 'landscape' ? '16x9' : 'reel'}.${ext}`;
  let writable = null;
  if (S.mode === 'full' && window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Video', accept: { [mime.split(';')[0] || 'video/webm']: [`.${ext}`] } }] });
      writable = await h.createWritable();
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const ac = new AbortController(); st.rendering = ac;
  const prog = $('#renProg'), bar = prog.querySelector('.bar'), lbl = prog.querySelector('.lbl');
  prog.hidden = false; bar.style.width = '0'; $('#renderBtn').disabled = true; $('#result').hidden = true;
  const total = segs.reduce((a, x) => a + x.dur, 0);
  try {
    const out = await renderVideo({
      clips: st.clips, segments: segs, overlay: st.overlay, summary: s, stampMode: S.stamp, stampBox: STAMP_BOX,
      highlights: S.mode === 'highlights', showTitle: S.showTitle,
      musicUrl: st.music?.url, musicVol: +S.musicVol, camVol: +S.camVol, writable, signal: ac.signal,
      onProgress: p => {
        bar.style.width = `${p * 100}%`;
        const left = (1 - p) * total;
        lbl.textContent = L(`Rendering… ${Math.round(p * 100)}% · ${left > 90 ? Math.round(left / 60) + ' min' : Math.round(left) + ' s'} left`,
          `Oluşturuluyor… %${Math.round(p * 100)} · ${left > 90 ? Math.round(left / 60) + ' dk' : Math.round(left) + ' sn'} kaldı`);
      },
    });
    if (out.saved) toast(L('Saved to the file you chose.', 'Seçtiğiniz dosyaya kaydedildi.'), 6000);
    else {
      const url = URL.createObjectURL(out.blob);
      $('#resultVideo').src = url;
      const a = $('#downloadLink'); a.href = url; a.download = name;
      a.textContent = L(`Download ${out.ext.toUpperCase()} (${(out.blob.size / 1e6).toFixed(0)} MB)`, `${out.ext.toUpperCase()} indir (${(out.blob.size / 1e6).toFixed(0)} MB)`);
      $('#result').hidden = false;
      toast(L('Done! Preview it, then download.', 'Hazır! İzleyin, sonra indirin.'));
    }
  } catch (e) {
    try { await writable?.abort(); } catch {}
    if (e.name === 'AbortError') toast(L('Render cancelled.', 'İptal edildi.'));
    else { console.error(e); toast(`${L('Render failed', 'Oluşturma başarısız')}: ${e.message}`, 8000); }
  } finally {
    st.rendering = null; prog.hidden = true; $('#renderBtn').disabled = false;
  }
}

// ---------- UI ----------
function setSeg(attr, val) { $$(`[data-${attr}]`).forEach(b => b.classList.toggle('on', b.dataset[attr] === val)); }
function applyUI() {
  setSeg('kind', S.kind); setSeg('mode', S.mode);
  $('#hlOpts').hidden = S.mode !== 'highlights'; $('#fullOpts').hidden = S.mode !== 'full';
  $('#hlLen').value = String(S.hlLen); $('#hlClip').value = String(S.hlClip);
  $('#maxHr').value = S.maxHr; $('#stampSel').value = S.stamp;
  $('#musicVol').value = S.musicVol; $('#camVol').value = S.camVol; $('#showTitle').checked = S.showTitle;
}

function bind() {
  $('#vidBtn').onclick = $('#dropVid').onclick = () => $('#vidIn').click();
  $('#gpxBtn').onclick = $('#dropGpx').onclick = () => $('#gpxIn').click();
  $('#vidIn').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  $('#gpxIn').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' || e.target === drop) drop.classList.remove('over'); }));
  document.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });

  $('#playBtn').onclick = () => (v.paused ? v.play() : v.pause());
  v.onplay = () => ($('#playBtn').textContent = '❚❚'); v.onpause = () => ($('#playBtn').textContent = '▶');
  const scrub = $('#scrub');
  scrub.oninput = () => { scrubbing = true; const c = st.clips[st.cur]; if (c) v.currentTime = (scrub.value / 1000) * c.duration; };
  scrub.onchange = () => (scrubbing = false);
  $('#clipSel').onchange = e => selectClip(+e.target.value);
  $$('[data-kind]').forEach(b => (b.onclick = () => { S.kind = b.dataset.kind; save(); applyUI(); rebuildOverlay(); }));
  $$('[data-mode]').forEach(b => (b.onclick = () => { S.mode = b.dataset.mode; save(); applyUI(); }));
  $('#tzIn').onchange = e => { st.tz = +e.target.value || 0; S.tz = st.tz; save(); resync(); };
  $('#offIn').oninput = e => { st.offset = +e.target.value; $('#offLbl').textContent = `${st.offset.toFixed(1)} s`; applySync(st.clips, st.tz, st.offset); };
  $('#offIn').onchange = () => resync();
  $('#hlLen').onchange = e => { S.hlLen = +e.target.value; save(); refreshHighlights(); };
  $('#hlClip').onchange = e => { S.hlClip = +e.target.value; save(); refreshHighlights(); };
  $('#hlList').onclick = e => { const li = e.target.closest('li[data-i]'); if (!li) return; const s = st.segs[+li.dataset.i]; selectClip(s.clip, s.start); };
  $('#trimANow').onclick = () => ($('#trimA').value = fmt(joinedNow()));
  $('#trimBNow').onclick = () => ($('#trimB').value = fmt(joinedNow()));
  $('#titleIn').onchange = () => rebuildOverlay();
  $('#showTitle').onchange = e => { S.showTitle = e.target.checked; save(); };
  $('#maxHr').onchange = e => { S.maxHr = +e.target.value || 185; save(); rebuildOverlay(); };
  $('#stampSel').onchange = e => { S.stamp = e.target.value; save(); rebuildOverlay(); };
  $('#musicVol').oninput = e => { S.musicVol = +e.target.value; save(); };
  $('#camVol').oninput = e => { S.camVol = +e.target.value; save(); };
  $('#musicBtn').onclick = () => $('#musicIn').click();
  $('#musicIn').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    if (st.music) URL.revokeObjectURL(st.music.url);
    st.music = { name: f.name, url: URL.createObjectURL(f) };
    $('#musicName').textContent = f.name; $('#musicClear').hidden = false; e.target.value = '';
  };
  $('#musicClear').onclick = () => { if (st.music) URL.revokeObjectURL(st.music.url); st.music = null; $('#musicName').textContent = ''; $('#musicClear').hidden = true; };
  $('#renderBtn').onclick = doRender;
  $('#renCancel').onclick = () => st.rendering?.abort();
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea') || !st.clips.length) return;
    if (e.code === 'Space') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
    if (e.code === 'ArrowLeft') v.currentTime -= 5;
    if (e.code === 'ArrowRight') v.currentTime += 5;
  });
  window.I18N?.on(() => { refreshFiles(); refreshSync(); refreshHighlights(); });
}

function init() {
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || !window.MediaRecorder || !('requestVideoFrameCallback' in HTMLVideoElement.prototype);
  $('#deviceNote').hidden = !mobile;
  $('#tzIn').value = st.tz;
  applyUI(); bind(); loadFonts().then(() => rebuildOverlay());
  requestAnimationFrame(loop);
}
init();
