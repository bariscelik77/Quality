// Reelmetry brand: the logo mark (film reel + data line) and the corner stamp on every video.
// Same geometry as the desktop app's brand.py (100 x 100 box).
import { FONT } from './overlay.js';

export const NAME = 'Reelmetry';
const ORANGE = '#ff7a3d', WHITE = '#ffffff';
const HOLES = [[50, 27], [30, 61], [70, 61]];
const LINE = [[2, 58], [20, 58], [28, 44], [38, 70], [48, 40], [58, 62], [66, 50], [98, 50]];

/** draws the mark with its top-left at (x, y), size px */
export function drawMark(g, x, y, size, { shadow = false } = {}) {
  const s = size / 100;
  g.save(); g.translate(x, y); g.scale(s, s);
  g.lineCap = g.lineJoin = 'round';
  const line = () => { g.beginPath(); LINE.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); };
  if (shadow) {
    g.strokeStyle = 'rgba(0,0,0,.43)';
    g.lineWidth = 12; g.beginPath(); g.arc(50, 50, 40, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 9; line(); g.stroke();
  }
  g.strokeStyle = ORANGE; g.lineWidth = 7; g.beginPath(); g.arc(50, 50, 40, 0, Math.PI * 2); g.stroke();
  g.fillStyle = ORANGE; HOLES.forEach(([hx, hy]) => { g.beginPath(); g.arc(hx, hy, 8, 0, Math.PI * 2); g.fill(); });
  g.fillStyle = WHITE; g.beginPath(); g.arc(50, 50, 5, 0, Math.PI * 2); g.fill();
  g.strokeStyle = WHITE; g.lineWidth = 5; line(); g.stroke();
  g.restore();
}

/** the corner stamp: mark + 'Reel' 'metry', top-right, ~5.5% of the short side */
export function drawStamp(g, W, H) {
  const short = Math.min(W, H), h = Math.max(28, Math.round(short * 0.055)), pad = Math.round(short * 0.03);
  const px = Math.round(h * 0.62), gap = h * 0.22;
  g.save();
  g.font = `700 ${px}px ${FONT}, "Segoe UI", sans-serif`;
  g.textBaseline = 'middle'; g.textAlign = 'left';
  const w1 = g.measureText('Reel').width, w2 = g.measureText('metry').width;
  const total = h + gap + w1 + w2, x = W - pad - total, y = pad, ty = y + h / 2;
  g.globalAlpha = 0.92;
  drawMark(g, x, y, h, { shadow: true });
  g.lineWidth = Math.max(2, h / 11); g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineJoin = 'round';
  g.strokeText('Reel', x + h + gap, ty); g.strokeText('metry', x + h + gap + w1, ty);
  g.fillStyle = WHITE; g.fillText('Reel', x + h + gap, ty);
  g.fillStyle = ORANGE; g.fillText('metry', x + h + gap + w1, ty);
  g.restore();
}
