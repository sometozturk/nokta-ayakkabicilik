#!/usr/bin/env node
// 3D mağaza / vitrin için dekupe (arka planı şeffaf) ürün görseli üretir.
// Çıktı: assets/vitrin/<id>.webp — sadece eksik olanlar üretilir, elle hazırlananlara dokunulmaz.
// Shopier'deki ilk fotoğraflar tek renk fonda çekildiği için fon, kenarlardan başlayan
// renk taşmasıyla (flood fill) silinir; fondaki logo gibi küçük adacıklar atılır.
// Kullanım: node scripts/build-vitrin.mjs   (sharp gerekir: npm i --no-save sharp)
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'vitrin');
const WIDTH = 760;
mkdirSync(OUT, { recursive: true });

export async function cutout(buf) {
    const { data, info } = await sharp(buf).rotate().resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    const px = (i) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];

    // Fon rengi: kenar piksellerinin ortancası
    const edge = [];
    for (let x = 0; x < w; x += 4) edge.push(px(x), px((h - 1) * w + x));
    for (let y = 0; y < h; y += 4) edge.push(px(y * w), px(y * w + w - 1));
    const med = [0, 1, 2].map(c => edge.map(e => e[c]).sort((a, b) => a - b)[edge.length >> 1]);
    const dist = (i) => { const p = px(i); return Math.hypot(p[0] - med[0], p[1] - med[1], p[2] - med[2]); };

    // Kenarlardan taşma: fona benzeyen ve kenara bağlı her piksel fon sayılır
    const TOL = 16;
    const bg = new Uint8Array(w * h);
    const stack = [];
    const seed = (i) => { if (!bg[i] && dist(i) < TOL) { bg[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (stack.length) {
        const i = stack.pop(), x = i % w, y = (i / w) | 0;
        if (x > 0) seed(i - 1); if (x < w - 1) seed(i + 1);
        if (y > 0) seed(i - w); if (y < h - 1) seed(i + w);
    }

    // Ön plan adacıkları: en büyüğü (ayakkabı/çift) ve ona yakın büyüklüktekiler kalır
    const lab = new Int32Array(w * h).fill(-1);
    const sizes = [];
    for (let s = 0; s < w * h; s++) {
        if (bg[s] || lab[s] >= 0) continue;
        const id = sizes.length; let n = 0; const st = [s]; lab[s] = id;
        while (st.length) {
            const i = st.pop(), x = i % w, y = (i / w) | 0; n++;
            for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
                if (j >= 0 && !bg[j] && lab[j] < 0) { lab[j] = id; st.push(j); }
            }
        }
        sizes.push(n);
    }
    if (!sizes.length) throw new Error('ön plan bulunamadı');
    const biggest = Math.max(...sizes);
    const keep = sizes.map(n => n >= biggest * .12);

    // Alfa + 1 piksellik yumuşak kenar
    const out = Buffer.from(data);
    for (let i = 0; i < w * h; i++) {
        const fg = lab[i] >= 0 && keep[lab[i]];
        if (!fg) { out[i * 4 + 3] = 0; continue; }
        const x = i % w, y = (i / w) | 0;
        const nearBg = (x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (y > 0 && bg[i - w]) || (y < h - 1 && bg[i + w]);
        out[i * 4 + 3] = nearBg ? 150 : 255;
    }
    return sharp(out, { raw: { width: w, height: h, channels: 4 } })
        .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
        .resize(WIDTH, null, { withoutEnlargement: false })
        .webp({ quality: 82, alphaQuality: 90 })
        .toBuffer();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const products = JSON.parse(readFileSync(join(ROOT, 'products.json'), 'utf8'));
    let made = 0, failed = 0;
    for (const p of products) {
        if (!p || p.id == null) continue;
        const file = join(OUT, `${p.id}.webp`);
        if (existsSync(file)) continue;
        const src = (p.images && p.images[0]) || p.image;
        if (!src) continue;
        try {
            const res = await fetch(src);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const webp = await cutout(Buffer.from(await res.arrayBuffer()));
            await sharp(webp).toFile(file);
            made++;
        } catch (e) {
            failed++;
            console.warn(`vitrin ${p.id} üretilemedi: ${e.message}`);
        }
    }
    console.log(`vitrin: ${made} yeni görsel, ${failed} hata`);
}
