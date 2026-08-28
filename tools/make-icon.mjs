#!/usr/bin/env node
/**
 * Generates the app icon as a PNG, with no image dependencies.
 *
 *   node tools/make-icon.mjs [--out <file>[:<size>] ...]
 *
 * Both `apps/tizen-app/config.xml` and `apps/webos-app/appinfo.json` reference an
 * `icon.png` that didn't exist, which breaks packaging on both platforms. Rather
 * than commit an opaque binary, the icon is drawn here so it can be tweaked and
 * regenerated: a 10-foot-friendly dark tile, a screen outline in the UI's accent
 * colour, and three dots suggesting a reply being composed.
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

// --- palette (same values the UI uses) ---
const BG = [0x05, 0x06, 0x0a];
const GLOW = [0x1b, 0x2b, 0x4a];
const ACCENT = [0x8a, 0xa0, 0xd0];
const BRIGHT = [0xe8, 0xee, 0xfc];

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** 1 inside the shape, 0 outside, smoothly across ~1.5px so edges aren't jagged. */
const coverage = (sdf) => clamp01(0.5 - sdf / 1.5);

/** Signed distance to a rounded rectangle centred on a `size`×`size` canvas. */
function roundedRectSdf(size, x, y, halfW, halfH, radius) {
  const dx = Math.abs(x - size / 2) - (halfW - radius);
  const dy = Math.abs(y - size / 2) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
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

      // Backdrop: a soft glow lifting the centre off the near-black base.
      const dCentre = Math.hypot(x - size / 2, y - size * 0.46) / (size * 0.62);
      const g = clamp01(1 - dCentre) ** 2;
      px[i] = mix(BG[0], GLOW[0], g * 0.85);
      px[i + 1] = mix(BG[1], GLOW[1], g * 0.85);
      px[i + 2] = mix(BG[2], GLOW[2], g * 0.85);

      // Screen outline: the difference of two rounded rects = a ring.
      const outer = roundedRectSdf(size, x, y, size * 0.33, size * 0.23, size * 0.05);
      const inner = roundedRectSdf(
        size, x, y, size * 0.33 - size * 0.028, size * 0.23 - size * 0.028, size * 0.035,
      );
      const ring = coverage(outer) * (1 - coverage(inner));
      if (ring > 0) set(px, i, ACCENT, ring);

      // Stand, so it reads as a TV rather than a window.
      const standTop = size / 2 + size * 0.23;
      const stand = coverage(Math.max(
        Math.abs(x - size / 2) - size * 0.09,
        Math.max(y - (standTop + size * 0.045), standTop - y),
      ));
      if (stand > 0) set(px, i, ACCENT, stand * 0.9);

      // Three dots: a reply being composed. Brightness rises left→right.
      for (let d = 0; d < 3; d++) {
        const cx = size / 2 + (d - 1) * size * 0.105;
        const dist = Math.hypot(x - cx, y - size / 2) - size * 0.032;
        const dot = coverage(dist);
        if (dot > 0) set(px, i, d === 2 ? BRIGHT : ACCENT, dot * (0.55 + d * 0.225));
      }
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
