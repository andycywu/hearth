#!/usr/bin/env node
/**
 * Generates the app icon as a PNG, with no image dependencies.
 *
 *   node tools/make-icon.mjs [--size 512] [--out <file>...]
 *
 * Both `apps/tizen-app/config.xml` and `apps/webos-app/appinfo.json` reference an
 * `icon.png` that didn't exist, which breaks packaging on both platforms. Rather
 * than commit an opaque binary, the icon is drawn here so it can be tweaked and
 * regenerated: a 10-foot-friendly dark tile, a screen outline in the UI's accent
 * colour, and three dots suggesting a reply being composed.
 *
 * Placeholder-quality on purpose — swap in real artwork when there is any.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const sizeArg = args.indexOf("--size");
const SIZE = sizeArg === -1 ? 512 : Number(args[sizeArg + 1]);
const outArgs = args.reduce((acc, a, i) => (a === "--out" ? [...acc, args[i + 1]] : acc), []);
const OUTPUTS = outArgs.length
  ? outArgs
  : ["apps/tizen-app/icon.png", "apps/webos-app/icon.png"].map((p) => resolve(root, p));

// --- palette (same values the UI uses) ---
const BG = [0x05, 0x06, 0x0a];
const GLOW = [0x1b, 0x2b, 0x4a];
const ACCENT = [0x8a, 0xa0, 0xd0];
const BRIGHT = [0xe8, 0xee, 0xfc];

const px = new Uint8Array(SIZE * SIZE * 4);

/** Signed distance to a rounded rectangle centred on the canvas. */
function roundedRectSdf(x, y, halfW, halfH, radius) {
  const dx = Math.abs(x - SIZE / 2) - (halfW - radius);
  const dy = Math.abs(y - SIZE / 2) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** 1 inside the shape, 0 outside, smoothly across ~1.5px so edges aren't jagged. */
const coverage = (sdf) => clamp01(0.5 - sdf / 1.5);

function set(i, rgb, alpha) {
  px[i] = mix(px[i], rgb[0], alpha);
  px[i + 1] = mix(px[i + 1], rgb[1], alpha);
  px[i + 2] = mix(px[i + 2], rgb[2], alpha);
  px[i + 3] = 255;
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;

    // Backdrop: a soft glow lifting the centre off the near-black base.
    const dCentre = Math.hypot(x - SIZE / 2, y - SIZE * 0.46) / (SIZE * 0.62);
    const g = clamp01(1 - dCentre) ** 2;
    px[i] = mix(BG[0], GLOW[0], g * 0.85);
    px[i + 1] = mix(BG[1], GLOW[1], g * 0.85);
    px[i + 2] = mix(BG[2], GLOW[2], g * 0.85);
    px[i + 3] = 255;

    // Screen outline: the difference of two rounded rects = a ring.
    const outer = roundedRectSdf(x, y, SIZE * 0.33, SIZE * 0.23, SIZE * 0.05);
    const inner = roundedRectSdf(x, y, SIZE * 0.33 - SIZE * 0.028, SIZE * 0.23 - SIZE * 0.028, SIZE * 0.035);
    const ring = coverage(outer) * (1 - coverage(inner));
    if (ring > 0) set(i, ACCENT, ring);

    // Stand, so it reads as a TV rather than a window.
    const standTop = SIZE / 2 + SIZE * 0.23;
    const stand = coverage(Math.max(
      Math.abs(x - SIZE / 2) - SIZE * 0.09,
      Math.max(y - (standTop + SIZE * 0.045), standTop - y),
    ));
    if (stand > 0) set(i, ACCENT, stand * 0.9);

    // Three dots: a reply being composed. Brightness rises left→right.
    for (let d = 0; d < 3; d++) {
      const cx = SIZE / 2 + (d - 1) * SIZE * 0.105;
      const dist = Math.hypot(x - cx, y - SIZE / 2) - SIZE * 0.032;
      const dot = coverage(dist);
      if (dot > 0) set(i, d === 2 ? BRIGHT : ACCENT, dot * (0.55 + d * 0.225));
    }
  }
}

function writePng(paths) {
  // Raw scanlines, each prefixed with filter type 0 (none).
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  // 10..12 = compression/filter/interlace, all 0.

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  for (const p of paths) {
    writeFileSync(p, png);
    console.log(`[icon] ${SIZE}×${SIZE} → ${p}`);
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Last: CRC_TABLE above is a `const`, so writing the file has to come after it.
writePng(OUTPUTS);
