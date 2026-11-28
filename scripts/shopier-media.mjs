#!/usr/bin/env node
/* scripts/shopier-media.json listesindeki fotoğrafları Shopier ürünlerine yükler (eskilerin yerine).
 * SHOPIER_PAT gerekir. Depo herkese açık: sadece durum kodları ve sayılar yazılır. */
import { readFileSync } from 'node:fs';
const PAT = process.env.SHOPIER_PAT;
if (!PAT) { console.error('SHOPIER_PAT yok'); process.exit(1); }
const API = 'https://api.shopier.com/v1';
const spec = JSON.parse(readFileSync(new URL('./shopier-media.json', import.meta.url))).products;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(method, path, body) {
  const res = await fetch(API + path, { method, headers: { accept: 'application/json', authorization: `Bearer ${PAT}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch {}
  return { status: res.status, data };
}
// Siteye yeni yüklenen görseller yayına girene kadar bekle
const all = [...new Set(Object.values(spec).flat())];
for (let t = 0; t < 40; t++) {
  const codes = await Promise.all(all.map(u => fetch(u, { method: 'HEAD' }).then(r => r.status).catch(() => 0)));
  const bad = codes.filter(c => c !== 200).length;
  console.log(`görsel kontrolü ${t + 1}: ${all.length - bad}/${all.length} hazır`);
  if (!bad) break;
  if (t === 39) { console.error('görseller yayına girmedi'); process.exit(1); }
  await sleep(15000);
}
let fail = 0;
for (const [id, urls] of Object.entries(spec)) {
  let list = urls;
  for (const limit of [urls.length, 8, 6, 5]) {
    list = urls.slice(0, limit);
    const media = list.map((url, i) => ({ type: 'image', url, placement: i + 1 }));
    const r = await call('PUT', `/products/${id}`, { media });
    console.log(`ürün ${id.slice(-3)}: ${list.length} görsel → ${r.status}`);
    if (r.status >= 200 && r.status < 300) break;
    if (limit === 5) fail++;
  }
  const g = await call('GET', `/products/${id}`);
  console.log(`ürün ${id.slice(-3)}: Shopier'de şimdi ${g.data?.media?.length ?? '?'} görsel`);
}
process.exit(fail ? 1 : 0);
