#!/usr/bin/env node
// Tek ödemeli sepetin Shopier API adımlarını dener: gizli ürünü farklı gövdelerle oluşturup hemen siler.
// Depo herkese açık: kayıtlara sadece durum kodları ve Shopier'in hata mesajı yazılır.
const API = 'https://api.shopier.com/v1';
const PAT = process.env.SHOPIER_PAT;
const call = async (method, path, body) => {
  const res = await fetch(API + path, { method, headers: { accept: 'application/json', authorization: `Bearer ${PAT}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
};
const errOf = (d) => JSON.stringify(d && (d.error || d.errors || d.message || d.detail || d.title || d.raw) || d).slice(0, 500);

const a = (await call('GET', '/products/50853560')).data;
const b = (await call('GET', '/products/40842449')).data;
console.log(`KDV alanı tipi: ${typeof a?.priceData?.vatPercent} / değer biçimi: ${String(a?.priceData?.vatPercent).replace(/\d/g, '9')}`);
const imgs = [a?.media?.[0]?.url, b?.media?.[0]?.url].filter(Boolean);
const base = {
  title: 'Nokta Sepeti · 2 çift · TEST silinecek',
  description: 'Sepet kodu: TEST\n\nOtomatik test, hemen silinir.',
  type: 'physical',
  priceData: { currency: 'TRY', price: '3609.00' },
  stockQuantity: 1,
  shippingPayer: 'sellerPays',
  customListing: true,
  dispatchDuration: 1
};
const variants = {
  'tek foto, KDV yok': { ...base, media: imgs.slice(0, 1).map((url, i) => ({ type: 'image', url, placement: i + 1 })) },
  'iki foto, KDV yok': { ...base, media: imgs.map((url, i) => ({ type: 'image', url, placement: i + 1 })) },
  'iki foto, KDV metin': { ...base, media: imgs.map((url, i) => ({ type: 'image', url, placement: i + 1 })), priceData: { ...base.priceData, vatPercent: String(a?.priceData?.vatPercent) } },
  'iki foto, KDV sayı': { ...base, media: imgs.map((url, i) => ({ type: 'image', url, placement: i + 1 })), priceData: { ...base.priceData, vatPercent: Number(a?.priceData?.vatPercent) } }
};
for (const [name, body] of Object.entries(variants)) {
  const r = await call('POST', '/products', body);
  console.log(`${name}: ${r.status} ${r.status >= 400 ? errOf(r.data) : ''}`);
  if (r.status < 400 && r.data?.id) await call('DELETE', `/products/${r.data.id}`);
}
