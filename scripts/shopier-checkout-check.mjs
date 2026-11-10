#!/usr/bin/env node
// Sepet sunucusunun Shopier'e gönderdiği ürün gövdesinin birebir aynısını dener, oluşursa hemen siler.
// Depo herkese açık: kayıtlara sadece durum kodları, alan adları ve Shopier'in hata mesajı yazılır.
import { _internal } from '../checkout-worker/src/index.js';
const API = 'https://api.shopier.com/v1';
const env = { SHOPIER_PAT: process.env.SHOPIER_PAT };
const call = async (method, path, body) => {
  const res = await fetch(API + path, { method, headers: { accept: 'application/json', authorization: `Bearer ${env.SHOPIER_PAT}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
};
const cart = [{ shopierId: '40842449', size: '40', qty: 1 }, { shopierId: '50853560', size: '42', qty: 1 }];
let priced;
try { priced = await _internal.priceCart(env, cart); console.log(`priceCart: tamam, toplam ${priced.total}`); }
catch (e) { console.log(`priceCart HATA: ${e.message} ${JSON.stringify(e.detail || {}).slice(0, 300)}`); process.exit(0); }
const body = _internal.bundleBody(priced, 'NS-TEST');
console.log(`gövde alanları: ${Object.keys(body).join(', ')} | fiyat alanları: ${JSON.stringify(Object.fromEntries(Object.entries(body.priceData).map(([k, v]) => [k, typeof v])))} | foto: ${body.media.length} | başlık uzunluğu: ${body.title.length} | açıklama uzunluğu: ${body.description.length}`);
const tryPost = async (name, b) => {
  const r = await call('POST', '/products', b);
  console.log(`${name}: ${r.status} ${r.status >= 400 ? JSON.stringify(r.data).slice(0, 500) : ''}`);
  if (r.status < 400 && r.data?.id) await call('DELETE', `/products/${r.data.id}`);
};
await tryPost('birebir gövde', body);
await tryPost('açıklama sade', { ...body, description: 'Sepet kodu: NS-TEST' });
await tryPost('başlık sade', { ...body, title: 'Nokta Sepeti TEST' });
await tryPost('foto yok', { ...body, media: [] });
