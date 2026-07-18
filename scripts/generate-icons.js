#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const outputDirectory = path.join(root, "chrome-extension", "icons");
const sizes = [16, 32, 48, 128];
const red = [0xb3, 0x26, 0x1e];
const white = [0xff, 0xff, 0xff];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

function adler32(buffer) {
  let first = 1;
  let second = 0;
  for (const byte of buffer) {
    first = (first + byte) % 65521;
    second = (second + first) % 65521;
  }
  return ((second << 16) | first) >>> 0;
}

function storedDeflate(buffer) {
  const chunks = [Buffer.from([0x78, 0x01])];
  for (let offset = 0; offset < buffer.length;) {
    const length = Math.min(0xffff, buffer.length - offset);
    const final = offset + length === buffer.length;
    const block = Buffer.alloc(5 + length);
    block[0] = final ? 1 : 0;
    block.writeUInt16LE(length, 1);
    block.writeUInt16LE((~length) & 0xffff, 3);
    buffer.copy(block, 5, offset, offset + length);
    chunks.push(block);
    offset += length;
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(adler32(buffer));
  chunks.push(checksum);
  return Buffer.concat(chunks);
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let current = 0, previous = points.length - 1;
    current < points.length;
    previous = current++) {
    const [currentX, currentY] = points[current];
    const [previousX, previousY] = points[previous];
    if (((currentY > y) !== (previousY > y)) &&
        x < (previousX - currentX) * (y - currentY) /
          (previousY - currentY) + currentX)
      inside = !inside;
  }
  return inside;
}

function insideRoundedSquare(x, y) {
  if (x < 0 || y < 0 || x >= 96 || y >= 96)
    return false;
  const closestX = Math.max(18, Math.min(78, x));
  const closestY = Math.max(18, Math.min(78, y));
  const deltaX = x - closestX;
  const deltaY = y - closestY;
  return deltaX * deltaX + deltaY * deltaY <= 18 * 18;
}

function artworkColor(x, y) {
  let color;
  if (insideRoundedSquare(x, y))
    color = red;
  if (x >= 19 && x < 77 && y >= 24 && y < 72)
    color = white;
  if (pointInPolygon(x, y, [
    [19, 27],
    [48, 50],
    [77, 27],
    [77, 39],
    [48, 62],
    [19, 39]
  ]))
    color = red;
  if (x >= 33 && x < 63 && y >= 17 && y < 33)
    color = white;
  if (pointInPolygon(x, y, [
    [38, 19],
    [58, 19],
    [58, 22],
    [45, 22],
    [52, 26],
    [45, 30],
    [58, 30],
    [58, 33],
    [38, 33],
    [38, 30],
    [47, 26],
    [38, 22]
  ]))
    color = red;
  return color;
}

function renderRgba(size) {
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);
  const artworkSize = size === 128 ? 96 : size;
  const offset = (size - artworkSize) / 2;
  const scale = artworkSize / 96;

  for (let pixelY = 0; pixelY < size; pixelY++) {
    for (let pixelX = 0; pixelX < size; pixelX++) {
      let alphaSamples = 0;
      const colorTotals = [0, 0, 0];
      for (let sampleY = 0; sampleY < samples; sampleY++) {
        for (let sampleX = 0; sampleX < samples; sampleX++) {
          const x = (
            pixelX + (sampleX + 0.5) / samples - offset
          ) / scale;
          const y = (
            pixelY + (sampleY + 0.5) / samples - offset
          ) / scale;
          const color = artworkColor(x, y);
          if (!color)
            continue;
          alphaSamples++;
          for (let channel = 0; channel < 3; channel++)
            colorTotals[channel] += color[channel];
        }
      }

      const index = (pixelY * size + pixelX) * 4;
      if (alphaSamples > 0) {
        for (let channel = 0; channel < 3; channel++) {
          pixels[index + channel] = Math.round(
            colorTotals[channel] / alphaSamples
          );
        }
      }
      pixels[index + 3] = Math.round(
        alphaSamples / (samples * samples) * 255
      );
    }
  }
  return pixels;
}

function encodePng(size) {
  const pixels = renderRgba(size);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", storedDeflate(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function main() {
  const check = process.argv[2] === "--check";
  if (process.argv.length > (check ? 3 : 2))
    throw new Error("Usage: generate-icons.js [--check]");

  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const size of sizes) {
    const filename = path.join(outputDirectory, `icon-${size}.png`);
    const expected = encodePng(size);
    if (check) {
      if (!fs.existsSync(filename) ||
          !fs.readFileSync(filename).equals(expected))
        throw new Error(`Generated icon is stale: ${path.basename(filename)}`);
    } else {
      fs.writeFileSync(filename, expected);
    }
  }
  console.log(`${check ? "Verified" : "Generated"} Chrome PNG icons.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
