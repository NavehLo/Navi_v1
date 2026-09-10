// Reading the canopy raster outside the browser.
//
// src/lib/canopy.ts decodes the same PNG with createImageBitmap and a canvas,
// which only exist in a browser. The build script needs the same numbers on the
// server, and the two must not disagree — so rather than add an image library
// as a dependency, this decodes the one narrow case the file actually is:
// 8-bit greyscale, non-interlaced, which is what scripts/buildCanopyRaster.sh
// produces and what the header is asserted to say below.
//
// zlib is built into Node, so this brings in nothing.

import { inflateSync } from 'node:zlib';

export function readGreyscalePng(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('not a PNG');
  }

  let width = 0, height = 0;
  const idat = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [bitDepth, colorType, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (bitDepth !== 8 || colorType !== 0 || interlace !== 0) {
        throw new Error(`canopy raster must be 8-bit non-interlaced greyscale, got bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height);

  // One byte per pixel, so "the pixel to the left" is one byte back and "the
  // pixel above" is one row back in the output. Filters are undone in place,
  // row by row, exactly as the PNG spec defines them.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)];
    const src = y * (width + 1) + 1;
    const dst = y * width;
    for (let x = 0; x < width; x++) {
      const value = raw[src + x];
      const left = x > 0 ? out[dst + x - 1] : 0;
      const up = y > 0 ? out[dst - width + x] : 0;
      const upLeft = x > 0 && y > 0 ? out[dst - width + x - 1] : 0;
      let restored;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + left; break;
        case 2: restored = value + up; break;
        case 3: restored = value + ((left + up) >> 1); break;
        case 4: restored = value + paeth(left, up, upLeft); break;
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      out[dst + x] = restored & 0xff;
    }
  }

  return { width, height, data: out };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
