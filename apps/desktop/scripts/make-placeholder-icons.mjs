#!/usr/bin/env node
/**
 * Generate the placeholder application icons from code.
 *
 * Why generate instead of committing artwork: the project has no brand assets
 * yet, and a hand-drawn binary in git is unreviewable -- nobody can tell a
 * placeholder from a real logo by looking at a diff. A script that draws a
 * dashed frame and a letter says exactly what it is, and regenerating it is one
 * command. When real artwork arrives, it overwrites `build/icon.png`,
 * `build/icon.ico` and `build/icon.icns`; this script is then deleted rather
 * than kept as a second source of truth.
 *
 *   node apps/desktop/scripts/make-placeholder-icons.mjs
 *
 * Output is byte-identical across runs: the rasterizer is pure integer/float
 * math with no time or randomness, and zlib's deflate at a fixed level is
 * deterministic for a fixed input. That is what lets the icons be reviewed by
 * re-running the generator instead of by reading binary blobs.
 *
 * The drawing is deliberately NOT a brand mark: a neutral rounded square, a
 * dashed outline (the universal "something belongs here later" motif) and a
 * plain capital H for the project name. It must not resemble the Electron
 * default icon -- that one is a blue circle with a stylised electron, and the
 * whole point of this file is to stop shipping it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const OUT_DIR = path.join(DESKTOP_DIR, "build");

/** Sizes embedded in the Windows icon, largest first. */
const ICO_SIZES = [256, 128, 64, 48, 32, 16];

/** Edge length of the PNG, in pixels. */
const PNG_SIZE = 512;

/**
 * Colours, as linear 0..255 channels plus alpha.
 *
 * Deliberately low-chroma: a saturated placeholder reads as a brand colour and
 * someone will eventually mistake it for one.
 */
const BACKGROUND = [42, 47, 54, 255]; // dark slate
const BORDER = [124, 135, 148, 235]; // mid grey, dashed
const GLYPH = [232, 235, 239, 255]; // near-white

/** Draw with this many sub-samples per axis; 3 is enough together with the
 * distance-based coverage below, and keeps a 512px render under a second. */
const SUPERSAMPLE = 3;

/**
 * Signed distance from a point to a rounded rectangle: negative inside.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} cx centre x
 * @param {number} cy centre y
 * @param {number} hw half width
 * @param {number} hh half height
 * @param {number} r corner radius
 * @returns {number}
 */
function roundedBoxSdf(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - hw + r;
  const dy = Math.abs(y - cy) - hh + r;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - r;
}

/**
 * Coverage of a shape from its signed distance, in pixels.
 *
 * Returns 1 well inside, 0 well outside, and a linear ramp across one pixel of
 * the supersampled grid. Doing this per sub-sample (rather than a hard
 * threshold) is what keeps the ring and the glyph edges from looking stepped
 * at 16px, where a rounded corner is only three pixels across.
 *
 * @param {number} distance
 * @returns {number} 0..1
 */
function coverage(distance) {
  return Math.min(Math.max(0.5 - distance, 0), 1);
}

/**
 * Is a point inside the dash pattern of the thin frame?
 *
 * The frame is drawn edge by edge with square dash gaps, and the four corners
 * are left empty. A true arc-length dash along the rounded path would need the
 * boundary parameterisation; corners that are simply not drawn are honest and
 * cost nothing, because at the sizes this is used (16-48px) a dash is barely a
 * pixel wide anyway.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} size canvas edge length
 * @returns {boolean}
 */
function inDashPattern(x, y, size) {
  const inset = size * 0.075;
  const half = size / 2;
  const reach = half - inset;
  const radius = size * 0.19;
  const stroke = size * 0.016;
  const dash = size * 0.058;
  const gap = size * 0.036;

  const dx = x - half;
  const dy = y - half;

  // Straight part of each edge only; the corner quarter-circles are skipped.
  const onVertical = Math.abs(Math.abs(dx) - reach) <= stroke / 2;
  const onHorizontal = Math.abs(Math.abs(dy) - reach) <= stroke / 2;
  const withinStraightX = Math.abs(dx) <= reach - radius && Math.abs(dy) <= reach + stroke;
  const withinStraightY = Math.abs(dy) <= reach - radius && Math.abs(dx) <= reach + stroke;

  if (onHorizontal && withinStraightX) {
    const phase = ((x % (dash + gap)) + dash + gap) % (dash + gap);
    return phase <= dash;
  }
  if (onVertical && withinStraightY) {
    const phase = ((y % (dash + gap)) + dash + gap) % (dash + gap);
    return phase <= dash;
  }
  return false;
}

/**
 * Colour of one sub-sample, composited back to front.
 *
 * @param {number} x in pixels of the supersampled canvas
 * @param {number} y
 * @param {number} size canvas edge length in supersampled pixels
 * @returns {[number, number, number, number]} premultiplied RGBA, 0..1
 */
function shade(x, y, size) {
  const unit = size / 512;
  const half = size / 2;

  // Canvas: rounded square, corner radius a fifth of the edge.
  const body = coverage(roundedBoxSdf(x, y, half, half, half, half, size * 0.205));
  if (body <= 0) return [0, 0, 0, 0];

  let r = BACKGROUND[0] / 255;
  let g = BACKGROUND[1] / 255;
  let b = BACKGROUND[2] / 255;
  let a = (BACKGROUND[3] / 255) * body;

  // Dashed frame: inset from the edge, inside the rounded corners.
  if (inDashPattern(x, y, size)) {
    const alpha = BORDER[3] / 255;
    r = r * (1 - alpha) + (BORDER[0] / 255) * alpha;
    g = g * (1 - alpha) + (BORDER[1] / 255) * alpha;
    b = b * (1 - alpha) + (BORDER[2] / 255) * alpha;
  }

  // Glyph: a capital H built from three bars, sized to survive 16px.
  const bar = 34 * unit;
  const glyphHalfWidth = 96 * unit;
  const glyphHalfHeight = 108 * unit;
  const crossTop = -bar / 2;
  const crossBottom = bar / 2;
  const left = roundedBoxSdf(
    x,
    y,
    half - glyphHalfWidth + bar / 2,
    half,
    bar / 2,
    glyphHalfHeight,
    bar * 0.16,
  );
  const right = roundedBoxSdf(
    x,
    y,
    half + glyphHalfWidth - bar / 2,
    half,
    bar / 2,
    glyphHalfHeight,
    bar * 0.16,
  );
  const cross = roundedBoxSdf(
    x,
    y,
    half,
    half,
    glyphHalfWidth - bar / 2,
    (crossBottom - crossTop) / 2,
    bar * 0.16,
  );
  const glyph = coverage(Math.min(left, right, cross));
  if (glyph > 0) {
    const alpha = (GLYPH[3] / 255) * glyph;
    r = r * (1 - alpha) + (GLYPH[0] / 255) * alpha;
    g = g * (1 - alpha) + (GLYPH[1] / 255) * alpha;
    b = b * (1 - alpha) + (GLYPH[2] / 255) * alpha;
    a = a * (1 - alpha) + alpha;
  }

  return [r * a, g * a, b * a, a];
}

/**
 * Rasterise one square RGBA image.
 *
 * @param {number} size edge length in pixels
 * @returns {Buffer} `size * size * 4` bytes, RGBA, row-major, top-down
 */
function renderRgba(size) {
  const supersampled = size * SUPERSAMPLE;
  const out = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          // Sample at the centre of each sub-pixel: an off-by-half offset here
          // is what makes a symmetric glyph come out asymmetric on one side.
          const [sr, sg, sb, sa] = shade(
            px * SUPERSAMPLE + sx + 0.5,
            py * SUPERSAMPLE + sy + 0.5,
            supersampled,
          );
          r += sr;
          g += sg;
          b += sb;
          a += sa;
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const alpha = a / samples;
      const offset = (py * size + px) * 4;
      if (alpha <= 0) continue;
      out[offset] = Math.round((r / a) * 255);
      out[offset + 1] = Math.round((g / a) * 255);
      out[offset + 2] = Math.round((b / a) * 255);
      out[offset + 3] = Math.round(alpha * 255);
    }
  }

  return out;
}

/**
 * Encode RGBA pixels as a PNG.
 *
 * Hand-rolled rather than pulling in a raster library: the only thing needed
 * here is one filter type and one colour type, and adding a dependency to draw
 * a placeholder would outlive the placeholder.
 *
 * @param {Buffer} rgba `width * height * 4` bytes
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function encodePng(rgba, width, height) {
  const stride = width * 4;
  // One filter byte per row. Filter 0 (None) keeps the output trivially
  // re-derivable by anyone reading the generator, at the cost of a slightly
  // larger file -- which is irrelevant for a handful of flat colours.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const deflated = zlib.deflateSync(raw, { level: 9 });

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflated),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * @param {string} type four ASCII characters
 * @param {Buffer} data
 * @returns {Buffer} length, type, data, CRC over type+data
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** @type {Uint32Array|null} */
let crcTable = null;

/**
 * @param {Buffer} bytes
 * @returns {number} unsigned 32-bit CRC-32 (the PNG/zlib polynomial)
 */
function crc32(bytes) {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Pack PNG images into a Windows icon.
 *
 * Every entry is PNG-compressed. The format has allowed that since Vista, and
 * this package targets Windows 10 exclusively, so the older BMP-in-ICO
 * encoding would be pure compatibility for an OS that cannot run Electron 45
 * anyway. Keeping one encoder keeps the generator reviewable.
 *
 * @param {{size: number, png: Buffer}[]} images
 * @returns {Buffer}
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const entry = index * 16;
    // 256 is written as 0: the width and height fields are single bytes.
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0; // palette size
    directory[entry + 3] = 0; // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

/**
 * Encode an ICNS container holding PNG entries.
 *
 * Apple is not a target of this project, so this is written but not required:
 * it exists so that "the icons are placeholders" is true of every format
 * electron-builder may ask for, rather than a Windows-only half-truth. ICNS
 * accepts PNG payloads for the modern types (ic07..ic10).
 *
 * @param {{type: string, png: Buffer}[]} images
 * @returns {Buffer}
 */
function encodeIcns(images) {
  // Each element is a 4-byte type, a 4-byte big-endian length that includes
  // those 8 bytes, and the payload -- so the length is written before the PNG
  // is appended, not into a separate header.
  const parts = images.map((image) => {
    const head = Buffer.alloc(8);
    head.write(image.type, 0, "latin1");
    head.writeUInt32BE(image.png.length + 8, 4);
    return Buffer.concat([head, image.png]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, "latin1");
  header.writeUInt32BE(8 + parts.reduce((sum, part) => sum + part.length, 0), 4);
  return Buffer.concat([header, ...parts]);
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const png = encodePng(renderRgba(PNG_SIZE), PNG_SIZE, PNG_SIZE);
  writeFileSync(path.join(OUT_DIR, "icon.png"), png);

  const ico = encodeIco(
    ICO_SIZES.map((size) => ({ size, png: encodePng(renderRgba(size), size, size) })),
  );
  writeFileSync(path.join(OUT_DIR, "icon.ico"), ico);

  const icns = encodeIcns([
    { type: "ic08", png: encodePng(renderRgba(256), 256, 256) },
    { type: "ic09", png: encodePng(renderRgba(512), 512, 512) },
    { type: "ic10", png: encodePng(renderRgba(1024), 1024, 1024) },
  ]);
  writeFileSync(path.join(OUT_DIR, "icon.icns"), icns);

  const listing = [
    ["icon.png", png.length],
    ["icon.ico", ico.length],
    ["icon.icns", icns.length],
  ];
  for (const [name, bytes] of listing) process.stdout.write(`  ${name}  ${bytes} B\n`);
  process.stdout.write(`wrote placeholder icons to ${OUT_DIR}\n`);
}

main();
