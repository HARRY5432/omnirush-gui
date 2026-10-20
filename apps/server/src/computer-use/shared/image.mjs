// Computer use, images: PNG encode/decode (node:zlib), an area-average
// downscale, a small baseline JPEG encoder (4:2:0, standard tables; written
// for this module, no third-party code), size sniffing and a tolerant frame
// compare. Plain Node: works in Electron main, the server, engine plugins and
// the CLI alike.
//
// The same file ships in omnirush-cli (src/computer-use/) and omnirush-gui
// (apps/server/src/computer-use/shared/); PARITY.sha256 lists it in both.
//
// Pixels are RGBA, 8 bits per channel, rows top to bottom:
// { width, height, data: Uint8Array(width * height * 4) }.

import { crc32, deflateSync, inflateSync } from "node:zlib";

// ---------------------------------------------------------------------- PNG

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const name = Buffer.from(type, "latin1");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(data, crc32(name)) >>> 0);
  return Buffer.concat([length, name, data, sum]);
}

/** RGBA pixels → PNG bytes (truecolor, alpha dropped when every pixel is opaque). */
export function encodePng(image, { level = 6 } = {}) {
  const { width, height, data } = image;
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
  const channels = opaque ? 3 : 4;
  const stride = width * channels + 1;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    let o = y * stride + 1;
    let s = y * width * 4;
    for (let x = 0; x < width; x += 1, s += 4) {
      rows[o++] = data[s]; rows[o++] = data[s + 1]; rows[o++] = data[s + 2];
      if (!opaque) rows[o++] = data[s + 3];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level })), chunk("IEND", Buffer.alloc(0))]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * PNG bytes → RGBA pixels, or null for what this decoder does not read
 * (16-bit, interlaced, a corrupt file, more than `maxPixels`).
 */
export function decodePng(bytes, { maxPixels = 40_000_000 } = {}) {
  try {
    const buf = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
    if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    let offset = 8;
    let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
    let palette = null, alpha = null;
    const idat = [];
    while (offset + 8 <= buf.length) {
      const length = buf.readUInt32BE(offset);
      const name = buf.toString("latin1", offset + 4, offset + 8);
      const data = buf.subarray(offset + 8, offset + 8 + length);
      offset += 12 + length;
      if (name === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
      else if (name === "PLTE") palette = data;
      else if (name === "tRNS") alpha = data;
      else if (name === "IDAT") idat.push(data);
      else if (name === "IEND") break;
    }
    if (!width || !height || depth !== 8 || interlace !== 0 || width * height > maxPixels) return null;
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
    if (!channels || (type === 3 && !palette)) return null;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return null;
    const out = new Uint8Array(width * height * 4);
    let prev = new Uint8Array(stride);
    const line = new Uint8Array(stride);
    for (let y = 0; y < height; y += 1) {
      const filter = raw[y * (stride + 1)];
      const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let i = 0; i < stride; i += 1) {
        const a = i >= channels ? line[i - channels] : 0;
        const b = prev[i];
        const c = i >= channels ? prev[i - channels] : 0;
        const v = src[i];
        line[i] = filter === 0 ? v : filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1) : filter === 4 ? v + paeth(a, b, c) : v;
      }
      for (let x = 0; x < width; x += 1) {
        const o = (y * width + x) * 4;
        if (type === 6) { out[o] = line[x * 4]; out[o + 1] = line[x * 4 + 1]; out[o + 2] = line[x * 4 + 2]; out[o + 3] = line[x * 4 + 3]; }
        else if (type === 2) { out[o] = line[x * 3]; out[o + 1] = line[x * 3 + 1]; out[o + 2] = line[x * 3 + 2]; out[o + 3] = 255; }
        else if (type === 0) { out[o] = out[o + 1] = out[o + 2] = line[x]; out[o + 3] = 255; }
        else if (type === 4) { out[o] = out[o + 1] = out[o + 2] = line[x * 2]; out[o + 3] = line[x * 2 + 1]; }
        else { const p = line[x]; out[o] = palette[p * 3] ?? 0; out[o + 1] = palette[p * 3 + 1] ?? 0; out[o + 2] = palette[p * 3 + 2] ?? 0; out[o + 3] = alpha && p < alpha.length ? alpha[p] : 255; }
      }
      prev = Uint8Array.from(line);
    }
    return { width, height, data: out };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- resizing

/** Area-average downscale to exactly width × height (never upscales usefully: use for shrinking). */
export function resize(image, width, height) {
  const sw = image.width, sh = image.height, src = image.data;
  if (sw === width && sh === height) return { width, height, data: Uint8Array.from(src) };
  const out = new Uint8Array(width * height * 4);
  const xs = new Int32Array(width + 1), ys = new Int32Array(height + 1);
  for (let x = 0; x <= width; x += 1) xs[x] = Math.min(sw, Math.round((x * sw) / width));
  for (let y = 0; y <= height; y += 1) ys[y] = Math.min(sh, Math.round((y * sh) / height));
  for (let y = 0; y < height; y += 1) {
    const y0 = ys[y], y1 = Math.max(ys[y + 1], y0 + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = xs[x], x1 = Math.max(xs[x + 1], x0 + 1);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < sh; yy += 1) {
        let s = (yy * sw + x0) * 4;
        for (let xx = x0; xx < x1 && xx < sw; xx += 1, s += 4) { r += src[s]; g += src[s + 1]; b += src[s + 2]; a += src[s + 3]; n += 1; }
      }
      const o = (y * width + x) * 4;
      n = n || 1;
      out[o] = (r / n + 0.5) | 0; out[o + 1] = (g / n + 0.5) | 0; out[o + 2] = (b / n + 0.5) | 0; out[o + 3] = (a / n + 0.5) | 0;
    }
  }
  return { width, height, data: out };
}

/** Downscales so the long side is at most `longSide` (a copy when it already fits). */
export function fitLongSide(image, longSide) {
  const ratio = Math.min(1, longSide / Math.max(image.width, image.height));
  if (ratio >= 1) return image;
  return resize(image, Math.max(1, Math.round(image.width * ratio)), Math.max(1, Math.round(image.height * ratio)));
}

/** Paints rectangles ({x, y, width, height} in pixels of `image`) solid in place. */
export function paintBoxes(image, boxes, color = [0, 0, 0]) {
  let painted = 0;
  for (const box of boxes ?? []) {
    const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(image.width, Math.ceil(box.x + box.width)), y1 = Math.min(image.height, Math.ceil(box.y + box.height));
    if (x1 <= x0 || y1 <= y0) continue;
    painted += 1;
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
      const o = (y * image.width + x) * 4;
      image.data[o] = color[0]; image.data[o + 1] = color[1]; image.data[o + 2] = color[2]; image.data[o + 3] = 255;
    }
  }
  return painted;
}

// --------------------------------------------------------------------- JPEG

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const LUMA_Q = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const CHROMA_Q = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...new Array(32).fill(99)];
const DC_LUMA = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const DC_CHROMA = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const AC_LUMA = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  vals: [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa],
};
const AC_CHROMA = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  vals: [0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa],
};

function huffmanCodes(table) {
  const codes = new Map();
  let code = 0, k = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < table.bits[length - 1]; i += 1) codes.set(table.vals[k++], [code++, length]);
    code <<= 1;
  }
  return codes;
}
const CODES = { dcY: huffmanCodes(DC_LUMA), dcC: huffmanCodes(DC_CHROMA), acY: huffmanCodes(AC_LUMA), acC: huffmanCodes(AC_CHROMA) };

function scaledTable(base, quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const s = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * s + 50) / 100))));
}

const COS = new Float64Array(64);
for (let x = 0; x < 8; x += 1) for (let u = 0; u < 8; u += 1) COS[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1);

/** In place: 8×8 samples (level-shifted) → DCT coefficients (natural order). */
function fdct(block, tmp) {
  for (let y = 0; y < 8; y += 1) for (let u = 0; u < 8; u += 1) {
    let sum = 0;
    for (let x = 0; x < 8; x += 1) sum += block[y * 8 + x] * COS[x * 8 + u];
    tmp[y * 8 + u] = sum / 2;
  }
  for (let u = 0; u < 8; u += 1) for (let v = 0; v < 8; v += 1) {
    let sum = 0;
    for (let y = 0; y < 8; y += 1) sum += tmp[y * 8 + u] * COS[y * 8 + v];
    block[v * 8 + u] = sum / 2;
  }
}

class BitWriter {
  constructor(size) { this.buf = Buffer.alloc(Math.max(1024, size)); this.pos = 0; this.acc = 0; this.n = 0; }
  byte(v) { if (this.pos >= this.buf.length) { const next = Buffer.alloc(this.buf.length * 2); this.buf.copy(next); this.buf = next; } this.buf[this.pos++] = v; }
  bits(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      this.n += 1;
      if (this.n === 8) { this.byte(this.acc); if (this.acc === 0xff) this.byte(0); this.acc = 0; this.n = 0; }
    }
  }
  flush() { if (this.n > 0) this.bits((1 << (8 - this.n)) - 1, 8 - this.n); return this.buf.subarray(0, this.pos); }
}

function category(v) {
  let a = Math.abs(v), n = 0;
  while (a) { n += 1; a >>= 1; }
  return n;
}

function encodeBlock(writer, block, table, dcCodes, acCodes, previous) {
  const q = new Int32Array(64);
  for (let k = 0; k < 64; k += 1) q[k] = Math.round(block[ZIGZAG[k]] / table[ZIGZAG[k]]);
  const diff = q[0] - previous;
  const dcCat = category(diff);
  const dc = dcCodes.get(dcCat);
  writer.bits(dc[0], dc[1]);
  if (dcCat) writer.bits(diff < 0 ? diff + (1 << dcCat) - 1 : diff, dcCat);
  let last = 63;
  while (last > 0 && q[last] === 0) last -= 1;
  let run = 0;
  for (let k = 1; k <= last; k += 1) {
    const v = q[k];
    if (v === 0) { run += 1; continue; }
    while (run > 15) { const z = acCodes.get(0xf0); writer.bits(z[0], z[1]); run -= 16; }
    const c = category(v);
    const code = acCodes.get((run << 4) | c);
    writer.bits(code[0], code[1]);
    writer.bits(v < 0 ? v + (1 << c) - 1 : v, c);
    run = 0;
  }
  if (last < 63) { const eob = acCodes.get(0x00); writer.bits(eob[0], eob[1]); }
  return q[0];
}

function segment(marker, payload) {
  const head = Buffer.alloc(4);
  head[0] = 0xff; head[1] = marker; head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function dhtPayload(tableClass, id, table) {
  return Buffer.from([(tableClass << 4) | id, ...table.bits, ...table.vals]);
}

/** RGBA pixels → baseline JPEG bytes (4:2:0, alpha ignored). */
export function encodeJpeg(image, { quality = 80 } = {}) {
  const { width, height, data } = image;
  const qy = scaledTable(LUMA_Q, quality), qc = scaledTable(CHROMA_Q, quality);
  const header = [
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])),
    segment(0xdb, Buffer.from([0, ...ZIGZAG.map((i) => qy[i]), 1, ...ZIGZAG.map((i) => qc[i])])),
    segment(0xc0, Buffer.from([8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])),
    segment(0xc4, Buffer.concat([dhtPayload(0, 0, DC_LUMA), dhtPayload(1, 0, AC_LUMA), dhtPayload(0, 1, DC_CHROMA), dhtPayload(1, 1, AC_CHROMA)])),
    segment(0xda, Buffer.from([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0])),
  ];
  const writer = new BitWriter((width * height) >> 2);
  const Y = new Float64Array(64 * 4), Cb = new Float64Array(64), Cr = new Float64Array(64), tmp = new Float64Array(64);
  const block = new Float64Array(64);
  let pY = 0, pCb = 0, pCr = 0;
  for (let my = 0; my < height; my += 16) {
    for (let mx = 0; mx < width; mx += 16) {
      Cb.fill(0); Cr.fill(0);
      for (let y = 0; y < 16; y += 1) {
        const sy = Math.min(height - 1, my + y);
        for (let x = 0; x < 16; x += 1) {
          const sx = Math.min(width - 1, mx + x);
          const o = (sy * width + sx) * 4;
          const r = data[o], g = data[o + 1], b = data[o + 2];
          const yb = ((y >> 3) << 1) | (x >> 3);
          Y[yb * 64 + (y & 7) * 8 + (x & 7)] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          const c = (y >> 1) * 8 + (x >> 1);
          Cb[c] += (-0.168736 * r - 0.331264 * g + 0.5 * b) / 4;
          Cr[c] += (0.5 * r - 0.418688 * g - 0.081312 * b) / 4;
        }
      }
      for (let b = 0; b < 4; b += 1) {
        for (let i = 0; i < 64; i += 1) block[i] = Y[b * 64 + i];
        fdct(block, tmp);
        pY = encodeBlock(writer, block, qy, CODES.dcY, CODES.acY, pY);
      }
      block.set(Cb); fdct(block, tmp); pCb = encodeBlock(writer, block, qc, CODES.dcC, CODES.acC, pCb);
      block.set(Cr); fdct(block, tmp); pCr = encodeBlock(writer, block, qc, CODES.dcC, CODES.acC, pCr);
    }
  }
  return Buffer.concat([...header, Buffer.from(writer.flush()), Buffer.from([0xff, 0xd9])]);
}

// ------------------------------------------------------------------- sniffing

/** { mime, width, height } of PNG, JPEG, GIF or WebP bytes, or null. */
export function imageInfo(bytes) {
  const b = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return { mime: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o += 1; continue; }
      const marker = b[o + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const length = b.readUInt16BE(o + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) return { mime: "image/jpeg", width: b.readUInt16BE(o + 7), height: b.readUInt16BE(o + 5) };
      o += 2 + length;
    }
    return { mime: "image/jpeg", width: 0, height: 0 };
  }
  if (b.length >= 10 && b.toString("latin1", 0, 3) === "GIF") return { mime: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const kind = b.toString("latin1", 12, 16);
    if (kind === "VP8X") return { mime: "image/webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8L") { const v = b.readUInt32LE(21); return { mime: "image/webp", width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
    if (kind === "VP8 ") return { mime: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    return { mime: "image/webp", width: 0, height: 0 };
  }
  return null;
}

/** File extension for an image mime type. */
export function extensionOf(mime) {
  return { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" }[String(mime ?? "").toLowerCase()] ?? "bin";
}

// ------------------------------------------------------------ frame compare

/** Mean luminance per cell (cell × cell pixels): the fingerprint the stale check compares. */
export function luminanceGrid(image, cell = 16) {
  const cols = Math.ceil(image.width / cell), rows = Math.ceil(image.height / cell);
  const sums = new Float64Array(cols * rows), counts = new Uint32Array(cols * rows);
  const d = image.data;
  for (let y = 0; y < image.height; y += 1) {
    const row = ((y / cell) | 0) * cols;
    for (let x = 0; x < image.width; x += 1) {
      const o = (y * image.width + x) * 4;
      const i = row + ((x / cell) | 0);
      sums[i] += 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
      counts[i] += 1;
    }
  }
  const values = new Float32Array(cols * rows);
  for (let i = 0; i < values.length; i += 1) values[i] = sums[i] / (counts[i] || 1);
  return { cell, cols, rows, width: image.width, height: image.height, values };
}

/**
 * Tolerant compare of two grids of the same image size: cells whose mean
 * luminance moved more than `threshold` count as changed, except cells that
 * touch a `mask` rectangle (caret, cursor). The changed "mass" (luminance
 * change × cell area, summed) estimates how many pixels changed and by how
 * much: a blinking caret, a spinner or a fading overlay scrollbar stay under
 * it, a dialog, a scrolled page or a new screen go over it. Stale when the
 * mass passes max(`minMass`, `fraction` of the image at mid-grey).
 */
export function compareGrids(a, b, { mask = [], threshold = 6, minMass = 60_000, fraction = 0.004 } = {}) {
  if (!a || !b || a.cols !== b.cols || a.rows !== b.rows || a.cell !== b.cell) return { stale: true, changed: -1 };
  let changed = 0, mass = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let r = 0; r < a.rows; r += 1) for (let c = 0; c < a.cols; c += 1) {
    const i = r * a.cols + c;
    const delta = Math.abs(a.values[i] - b.values[i]);
    if (delta <= threshold) continue;
    const x = c * a.cell, y = r * a.cell;
    if (mask.some((m) => x < m.x + m.width && x + a.cell > m.x && y < m.y + m.height && y + a.cell > m.y)) continue;
    changed += 1;
    mass += delta * Math.min(a.cell, a.width - x) * Math.min(a.cell, a.height - y);
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + a.cell); maxY = Math.max(maxY, y + a.cell);
  }
  const span = changed ? Math.max(maxX - minX, maxY - minY) : 0;
  const limit = Math.max(minMass, fraction * a.width * a.height * 128);
  return { stale: mass > limit, changed, span, mass: Math.round(mass) };
}
