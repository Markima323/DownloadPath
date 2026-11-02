import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name, data) {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function insidePolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function iconPng(size) {
  const arrow = [[.43,.22],[.57,.22],[.57,.44],[.69,.44],[.5,.64],[.31,.44],[.43,.44]];
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  const samples = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rgba = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
        const px = (x + (sx + .5) / samples) / size;
        const py = (y + (sy + .5) / samples) / size;
        const dx = Math.max(.20 - px, 0, px - .80);
        const dy = Math.max(.20 - py, 0, py - .80);
        if (dx * dx + dy * dy > .18 * .18) continue;
        const tray = py >= .64 && py <= .77 && px >= .25 && px <= .75
          && (py >= .71 || px <= .31 || px >= .69);
        const color = insidePolygon(px, py, arrow) || tray ? [233, 255, 246] : [13, 114 + Math.round(py * 24), 99];
        for (let channel = 0; channel < 3; channel++) rgba[channel] += color[channel];
        rgba[3] += 255;
      }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = rgba[3] ? Math.round(rgba[channel] * 255 / rgba[3]) : 0;
      pixels[offset + 3] = Math.round(rgba[3] / (samples * samples));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]);
}

export async function createIcons(directory) {
  await mkdir(directory, { recursive: true });
  await Promise.all([16, 32, 48, 128].map((size) => writeFile(path.join(directory, `icon-${size}.png`), iconPng(size))));
}
