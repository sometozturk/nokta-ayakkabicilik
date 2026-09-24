const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { removeBackground } = require('@imgly/background-removal-node');

const sourceDir = path.join(__dirname, 'assets', 'air-force-frames');
const outputDir = path.join(__dirname, 'assets', 'air-force-clean');
const files = fs.readdirSync(sourceDir)
  .filter((file) => /^ezgif-frame-\d+\.jpg$/i.test(file))
  .sort();

fs.mkdirSync(outputDir, { recursive: true });

async function processFrame(file) {
  const source = path.join(sourceDir, file);
  const output = path.join(outputDir, file.replace(/\.jpg$/i, '.webp'));
  const input = new Blob([fs.readFileSync(source)], { type: 'image/jpeg' });
  const result = await removeBackground(input, {
    output: { format: 'image/png' },
    model: 'medium'
  });
  const buffer = Buffer.from(await result.arrayBuffer());
  await sharp(buffer).webp({ quality: 90, alphaQuality: 95, effort: 4 }).toFile(output);
}

(async () => {
  for (let index = 0; index < files.length; index++) {
    await processFrame(files[index]);
    if ((index + 1) % 10 === 0) console.log(`Processed ${index + 1}/${files.length}`);
  }
  console.log(`Finished ${files.length} transparent frames.`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
