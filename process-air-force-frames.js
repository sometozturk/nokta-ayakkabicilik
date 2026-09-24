const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const sourceDir = path.join(__dirname, 'assets', 'air-force-frames');
const outputDir = path.join(__dirname, 'assets', 'air-force-clean');
const files = fs.readdirSync(sourceDir)
  .filter((file) => /^ezgif-frame-\d+\.jpg$/i.test(file))
  .sort();

fs.mkdirSync(outputDir, { recursive: true });

async function cleanFrame(file) {
  const source = path.join(sourceDir, file);
  const output = path.join(outputDir, file.replace(/\.jpg$/i, '.webp'));
  const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const pixels = Buffer.alloc(info.width * info.height * 4);

  for (let sourceOffset = 0, offset = 0; sourceOffset < data.length; sourceOffset += info.channels, offset += 4) {
    const red = data[sourceOffset];
    const green = data[sourceOffset + 1];
    const blue = data[sourceOffset + 2];
    const blueCast = blue - red;
    const blueCloud = blue - green;
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = 255;

    // Remove the blue studio background and its bluish haze while keeping neutral shoe pixels.
    if (blueCast > 6 || blueCloud > 3) {
      pixels[offset + 3] = 0;
      continue;
    }

  }

  await sharp(pixels, {
    raw: { width: info.width, height: info.height, channels: 4 }
  }).webp({ quality: 88, alphaQuality: 90, effort: 4 }).toFile(output);
}

(async () => {
  for (const file of files) await cleanFrame(file);
  console.log(`Processed ${files.length} transparent frames.`);
})();
