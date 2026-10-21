#!/usr/bin/env node
/**
 * Generates the app icon as a PNG, with no image dependencies.
 *
 *   node tools/make-icon.mjs [--out <file>[:<size>] ...]
 *
 * Both `apps/tizen-app/config.xml` and `apps/webos-app/appinfo.json` reference an
 * `icon.png` that didn't exist, which breaks packaging on both platforms. Rather
 * than commit an opaque binary, the icon is drawn here so it can be tweaked and
 * regenerated: a lit, warm tile with a flame (a hearth), because a dark icon on a television's dark app list is no icon.
 *
 * Placeholder-quality on purpose — swap in real artwork when there is any.
 *
 * ## Why the size is per output
 *
 * Both platforms were being handed the same 512×512 file, 25 KB of it, because
 * one constant produced both. Tizen's TV icon really is 512; webOS's is 80 with
 * a 130 large icon, so it was carrying 22 KB it had no use for — against a
 * package that is otherwise under 90 KB. The artwork is resolution-independent
 * (it is drawn from signed distance fields), so the fix is to draw it twice.
 *
 * The pixels are also RGB rather than RGBA now. Every pixel was opaque, so the
 * alpha channel was a byte per pixel of pure padding — a quarter of the raw
 * image, spent encoding the number 255 a quarter of a million times.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outArgs = args.reduce((acc, a, i) => (a === "--out" ? [...acc, args[i + 1]] : acc), []);

/** `path` or `path:size`. Sizes come from each platform's own icon spec. */
const OUTPUTS = outArgs.length
  ? outArgs.map(parseOutput)
  : [
      { path: resolve(root, "apps/tizen-app/icon.png"), size: 512 },
      { path: resolve(root, "apps/webos-app/icon.png"), size: 130 },
    ];

function parseOutput(spec) {
  // Split on the last colon so a Windows drive letter survives.
  const at = spec.lastIndexOf(":");
  if (at > 1) {
    const size = Number(spec.slice(at + 1));
    if (Number.isFinite(size) && size > 0) {
      return { path: resolve(root, spec.slice(0, at)), size };
    }
  }
  return { path: resolve(root, spec), size: 512 };
}

// --- palette ---
// A flame on a warm tile. The first icon was a dim blue television outline on near-black, which on a television's app list —
// itself dark — read as no icon at all: the owner found the app by guessing (2026-10-21). A hearth is a fire, and a lit tile
// is what a ten-foot list needs.
const TILE_TOP = [0xff, 0x9a, 0x3c];
const TILE_BOTTOM = [0xb8, 0x2e, 0x1c];
const FLAME_OUTER = [0xff, 0xf1, 0xd6];
const FLAME_INNER = [0xff, 0xb3, 0x47];

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Half-width of a flame at height t (0 = bottom, 1 = tip), as a fraction of its own full width: a round belly that tapers to a
 * point, leaning a little with height so it reads as flame rather than a drop.
 */
function flameHalfWidth(t) {
  if (t < 0 || t > 1) return 0;
  const belly = 0.34;
  if (t < belly) return Math.sqrt(Math.max(0, 1 - ((t - belly) / belly) ** 2));
  return Math.max(0, 1 - (t - belly) / (1 - belly)) ** 1.35;
}

/** Coverage of a flame whose box is [cx±w/2] × [bottom..bottom-h] in pixel space. */
function flame(size, x, y, cx, bottom, w, h, lean) {
  const t = (bottom - y) / h;
  if (t < 0 || t > 1) return 0;
  const half = (flameHalfWidth(t) * w) / 2;
  const centre = cx + lean * t * t * w;
  // Distance to the edge, in pixels, across the nearer horizontal side: good enough to anti-alias a soft shape.
  return clamp01(0.5 + (half - Math.abs(x - centre)) / (size * 0.004 + 0.75));
}

function set(px, i, rgb, alpha) {
  px[i] = mix(px[i], rgb[0], alpha);
  px[i + 1] = mix(px[i + 1], rgb[1], alpha);
  px[i + 2] = mix(px[i + 2], rgb[2], alpha);
}

/** The icon at one size, as RGB triples. Every proportion is a fraction of it. */
function render(size) {
  const px = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const v = y / size;
      px[i] = mix(TILE_TOP[0], TILE_BOTTOM[0], v);
      px[i + 1] = mix(TILE_TOP[1], TILE_BOTTOM[1], v);
      px[i + 2] = mix(TILE_TOP[2], TILE_BOTTOM[2], v);

      const outer = flame(size, x, y, size * 0.5, size * 0.8, size * 0.46, size * 0.62, 0.05);
      if (outer > 0) set(px, i, FLAME_OUTER, outer);
      const inner = flame(size, x, y, size * 0.5, size * 0.78, size * 0.24, size * 0.34, 0.03);
      if (inner > 0) set(px, i, FLAME_INNER, inner);
    }
  }
  return px;
}

function encodePng(size, px) {
  // Raw scanlines, each prefixed with filter type 0 (none).
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: RGB, no alpha — the artwork is fully opaque
  // 10..12 = compression/filter/interlace, all 0.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Last, because `CRC_TABLE` above is a `const` and writing a file needs it.
for (const { path, size } of OUTPUTS) {
  const png = encodePng(size, render(size));
  writeFileSync(path, png);
  console.log(`[icon] ${size}×${size} → ${path} (${(png.byteLength / 1024).toFixed(1)} KB)`);
}
