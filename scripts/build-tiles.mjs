#!/usr/bin/env node
// Sepet kapak fotoğrafı (kolaj) için her ürünün kare parçasını hazırlar.
// Çıktı: assets/tiles/<shopierId>.bin  →  gzip'lenmiş ham RGB, TILE x TILE piksel.
// Checkout worker bu parçaları çözmeden yan yana dizip PNG yapar (fotoğraf çözme gerekmez, CPU düşük).
// Kullanım: node scripts/build-tiles.mjs   (sharp gerekir: npm i --no-save sharp)
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';

export const TILE = 300;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'tiles');
mkdirSync(OUT, { recursive: true });

const products = JSON.parse(readFileSync(join(ROOT, 'products.json'), 'utf8'));
const idOf = (url) => String(url || '').split('?')[0].replace(/\/$/, '').split('/').pop();
const mid = (src) => String(src).replace('/pictures_large/', '/pictures_mid/');

let made = 0, failed = 0;
const wanted = new Set();
for (const p of products) {
    const id = idOf(p.url);
    if (!/^\d+$/.test(id)) continue;
    wanted.add(id);
    const file = join(OUT, `${id}.bin`);
    if (existsSync(file)) continue;
    const src = (p.images && p.images[0]) || p.image;
    if (!src) continue;
    try {
        let res = await fetch(mid(src));
        if (!res.ok) res = await fetch(src);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const raw = await sharp(Buffer.from(await res.arrayBuffer()))
            .resize(TILE, TILE, { fit: 'contain', background: '#ffffff' })
            .flatten({ background: '#ffffff' })
            .removeAlpha()
            .raw()
            .toBuffer();
        if (raw.length !== TILE * TILE * 3) throw new Error('boyut');
        writeFileSync(file, gzipSync(raw, { level: 9 }));
        made++;
    } catch (e) {
        failed++;
        console.log(`parça oluşturulamadı: ${id} (${e.message})`);
    }
}
// Satıştan kalkan ürünlerin parçalarını sil
let removed = 0;
for (const f of readdirSync(OUT)) {
    const id = f.replace(/\.bin$/, '');
    if (f.endsWith('.bin') && !wanted.has(id)) { unlinkSync(join(OUT, f)); removed++; }
}
console.log(`Kolaj parçaları: ${made} yeni, ${removed} silindi, ${failed} hata, toplam ${readdirSync(OUT).length}`);
