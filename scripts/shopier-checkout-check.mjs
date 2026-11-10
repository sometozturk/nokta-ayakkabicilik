#!/usr/bin/env node
// Tek ödemeli sepetin Shopier API adımlarını dener: ürün okuma, gizli ürün oluşturma, silme.
// Depo herkese açık: kayıtlara sadece durum kodları ve Shopier'in hata mesajı yazılır.
const API = 'https://api.shopier.com/v1';
const PAT = process.env.SHOPIER_PAT;
const call = async (method, path, body) => {
  const res = await fetch(API + path, { method, headers: { accept: 'application/json', authorization: `Bearer ${PAT}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: res.status, data };
};
const errOf = (d) => JSON.stringify(d && (d.error || d.errors || d.message || d.detail || d.title) || null).slice(0, 400);

const read = await call('GET', '/products/50853560');
console.log(`GET /products/{id}: ${read.status} ${read.status >= 400 ? errOf(read.data) : ''}`);
const img = read.data?.media?.[0]?.url;
console.log(`media[0] alanları: ${Object.keys(read.data?.media?.[0] || {}).join(', ')}`);
const body = {
  title: 'Nokta Sepeti · TEST · silinecek',
  description: 'Otomatik test, hemen silinir.',
  type: 'physical',
  media: img ? [{ type: 'image', url: img, placement: 1 }] : [],
  priceData: { currency: 'TRY', price: '10.00' },
  stockQuantity: 1,
  shippingPayer: 'sellerPays',
  customListing: true,
  dispatchDuration: 1
};
const created = await call('POST', '/products', body);
console.log(`POST /products: ${created.status} ${created.status >= 400 ? errOf(created.data) : ''}`);
if (created.status < 400 && created.data?.id) {
  console.log(`Yanıtta url var mı: ${Boolean(created.data.url)}`);
  const del = await call('DELETE', `/products/${created.data.id}`);
  console.log(`DELETE /products/{id}: ${del.status}`);
}
