'use strict';
/**
 * Generates assets/icon.png (512), assets/tray.png (32) and assets/trayTemplate.png (32, macOS template).
 * Original design: a gauge (270° arc, partly filled) with a needle. No dependencies.
 *   node scripts/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in unit coordinates (0..1), returning coverage 0/1 for a sample point
const START = 135, SWEEP = 270, FILL = 0.62; // degrees, clockwise from +x (screen coords)
function angleOf(x, y) { let a = Math.atan2(y - 0.5, x - 0.5) * 180 / Math.PI; a = (a - START + 720) % 360; return a; }
function inRoundRect(x, y, r) {
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0), qy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return qx * qx + qy * qy <= r * r;
}
function arc(x, y, R, w, from, to) {
  const d = Math.hypot(x - 0.5, y - 0.5);
  if (Math.abs(d - R) > w / 2) {
    // round caps
    for (const a of [from, to]) {
      const rad = (START + a) * Math.PI / 180;
      const cx = 0.5 + R * Math.cos(rad), cy = 0.5 + R * Math.sin(rad);
      if (Math.hypot(x - cx, y - cy) <= w / 2) return true;
    }
    return false;
  }
  const a = angleOf(x, y);
  return a >= from && a <= to;
}
function needle(x, y, len, w) {
  const rad = (START + SWEEP * FILL) * Math.PI / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const px = x - 0.5, py = y - 0.5;
  const tt = Math.max(0, Math.min(len, px * dx + py * dy));
  return Math.hypot(px - tt * dx, py - tt * dy) <= w / 2;
}

function render(size, { template = false, bg = true } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4;
  const R = bg ? 0.30 : 0.36, W = bg ? 0.085 : 0.13;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) / size, y = (py + (sy + 0.5) / SS) / size;
        let c = null;
        const track = arc(x, y, R, W, 0, SWEEP);
        const fill = arc(x, y, R, W, 0, SWEEP * FILL);
        const hub = Math.hypot(x - 0.5, y - 0.5) <= W * 0.75;
        const nd = needle(x, y, R * 0.82, W * 0.55);
        if (template) {
          if (fill || hub || nd) c = [0, 0, 0, 255];
          else if (track) c = [0, 0, 0, 110];
        } else {
          if (bg && inRoundRect(x, y, 0.22)) {
            const g = y; // vertical gradient
            c = [Math.round(52 + 30 * g), Math.round(84 + 20 * g), Math.round(214 - 40 * g), 255];
          }
          if (track) c = [255, 255, 255, bg ? 90 : 120];
          if (fill) c = [255, 255, 255, 255];
          if (hub || nd) c = [255, 255, 255, 255];
          if (c && !bg && c[3] < 255 && !track) c = null;
        }
        if (c) {
          // blend white-over-bg for semi-transparent track on the background
          if (!template && bg && c[3] < 255) {
            const b = [Math.round(52 + 30 * y), Math.round(84 + 20 * y), Math.round(214 - 40 * y)];
            const a = c[3] / 255;
            c = [b[0] + (255 - b[0]) * a, b[1] + (255 - b[1]) * a, b[2] + (255 - b[2]) * a, 255];
          }
          acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3];
        }
      }
      const i = (py * size + px) * 4;
      const n = SS * SS;
      buf[i + 3] = Math.round(acc[3] / n);
      if (acc[3]) { buf[i] = Math.round(acc[0] / acc[3]); buf[i + 1] = Math.round(acc[1] / acc[3]); buf[i + 2] = Math.round(acc[2] / acc[3]); }
    }
  }
  return png(size, buf);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), render(512));
fs.writeFileSync(path.join(out, 'tray.png'), render(32));
fs.writeFileSync(path.join(out, 'trayTemplate.png'), render(32, { template: true, bg: false }));
console.log('Wrote assets/icon.png, tray.png, trayTemplate.png');
