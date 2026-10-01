/** Compare renders from the SAME renderer/font environment, never HTML vs Office. */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
const [beforePath, afterPath, outputPrefix, toolsDir] = process.argv.slice(2);
if (!outputPrefix) throw new Error('Usage: node scripts/pptx/compare-renders.mjs BEFORE.png AFTER.png OUTPUT_PREFIX [EXTERNAL_NODE_MODULES]');
const require = createRequire(toolsDir ? resolve(toolsDir, '../package.json') : import.meta.url);
const sharp = require('sharp');
const decode = path => sharp(path).flatten({ background: '#fff' }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
const [before, after] = await Promise.all([decode(beforePath), decode(afterPath)]);
const { width, height, channels } = before.info;
if (width !== after.info.width || height !== after.info.height || channels !== after.info.channels) {
  throw new Error('Render dimensions differ; use the same renderer and resolution.');
}
const tileSize = 128;
const channelTolerance = 24;
const tileFractionLimit = 0.05;
const difference = Buffer.alloc(width * height * 3, 255);
const tiles = [];
for (let top = 0; top < height; top += tileSize) {
  for (let left = 0; left < width; left += tileSize) {
    let changed = 0;
    const w = Math.min(tileSize, width - left), h = Math.min(tileSize, height - top);
    for (let y = top; y < top + h; y++) {
      for (let x = left; x < left + w; x++) {
        const at = (y * width + x) * channels;
        const delta = Math.max(...[0, 1, 2].map(c => Math.abs(before.data[at + c] - after.data[at + c])));
        if (delta > channelTolerance) {
          changed++;
          const out = (y * width + x) * 3;
          difference[out] = 220; difference[out + 1] = 0; difference[out + 2] = 80;
        }
      }
    }
    if (changed) tiles.push({ left, top, width: w, height: h, changedFraction: changed / (w * h) });
  }
}
const failed = tiles.filter(t => t.changedFraction > tileFractionLimit);
const report = { beforePath, afterPath, width, height, channelTolerance, tileSize, tileFractionLimit,
  passed: failed.length === 0, failedTiles: failed, changedTiles: tiles };
await sharp(difference, { raw: { width, height, channels: 3 } }).png().toFile(`${outputPrefix}.png`);
await writeFile(`${outputPrefix}.json`, JSON.stringify(report, null, 2));
console.log(`${report.passed ? 'PASS' : 'REVIEW REQUIRED'}: ${failed.length} changed regions`);
process.exitCode = report.passed ? 0 : 1;
