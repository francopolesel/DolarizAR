// Genera icons/icon{16,32,48,128}.png sin dependencias (Node + zlib).
// Diseño: rounded square verde, "$" blanco en bitmap, barra dorada.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'icons'), { recursive: true });

// S de 5x7 + barra vertical = "$".
const GLYPH = [
  [0, 1, 1, 1, 1],
  [1, 0, 0, 0, 0],
  [1, 0, 0, 0, 0],
  [0, 1, 1, 1, 0],
  [0, 0, 0, 0, 1],
  [0, 0, 0, 0, 1],
  [1, 1, 1, 1, 0]
];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a;
  };
  const radius = Math.round(size * 0.22);
  const sc = Math.max(1, Math.round(size * 0.075));
  const gw = 5 * sc, gh = 7 * sc;
  const ox = Math.round((size - gw) / 2);
  const oy = Math.round((size - gh) / 2) - Math.max(1, Math.round(size * 0.04));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Rounded rect.
      const cx = Math.min(Math.max(x, radius), size - 1 - radius);
      const cy = Math.min(Math.max(y, radius), size - 1 - radius);
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue; // transparente
      let r = 11, g = 122, b = 62; // #0B7A3E
      // Barra dorada inferior.
      const barH = Math.max(1, Math.round(size * 0.07));
      const barY = Math.round(size * 0.74);
      const barX0 = Math.round(size * 0.2), barX1 = Math.round(size * 0.8);
      if (y >= barY && y < barY + barH && x >= barX0 && x <= barX1) {
        r = 255; g = 197; b = 61;
      } else {
        // Glifo "$".
        const gx = Math.floor((x - ox) / sc), gy = Math.floor((y - oy) / sc);
        if (gx >= 0 && gx < 5 && gy >= 0 && gy < 7 && (GLYPH[gy][gx] === 1 || gx === 2)) {
          r = 255; g = 255; b = 255;
        }
      }
      set(x, y, r, g, b);
    }
  }
  return encodePNG(size, size, px);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(root, 'icons', `icon${size}.png`), drawIcon(size));
  console.log(`icons/icon${size}.png OK`);
}
