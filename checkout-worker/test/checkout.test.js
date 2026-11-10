import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

// --- D1 taklidi (node:sqlite üstünde) ---
function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    raw: db,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async run() { db.prepare(sql).run(...args); return { success: true }; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async all() { return { results: db.prepare(sql).all(...args) }; }
      };
      return stmt;
    }
  };
}

// --- Shopier API taklidi ---
let products, calls, nextId;
const product = (id, title, price, sizes, extra = {}) => ({
  id, title, url: `https://www.shopier.com/${id}`,
  media: [{ id: 'm' + id, type: 'image', url: `https://cdn.shopier.app/pictures_large/noktaayakkabi_${id}.png`, placement: 1 }],
  priceData: { currency: 'TRY', price: String(price), discount: false, discountedPrice: '', vatPercent: '20' },
  stockStatus: 'inStock',
  variants: Object.entries(sizes).map(([size, qty]) => ({
    variationId: ['v1'], variationTitle: ['Numara'], selectionId: ['s' + size], selectionTitle: [size],
    stockStatus: qty > 0 ? 'inStock' : 'outOfStock', stockQuantity: qty, primary: size === Object.keys(sizes)[0]
  })),
  customListing: false,
  ...extra
});

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method, path: u.pathname, body, auth: init.headers?.authorization });
  const send = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  let m;
  if ((m = u.pathname.match(/^\/v1\/products\/(\d+)$/))) {
    const p = products.get(m[1]);
    if (method === 'GET') return p ? send(200, p) : send(404, { error: 'not found' });
    if (method === 'DELETE') { products.delete(m[1]); return send(200, {}); }
    if (method === 'PUT') { Object.assign(p, body); return send(200, p); }
  }
  if (u.pathname === '/v1/products' && method === 'POST') {
    const id = String(nextId++);
    const created = { ...body, id, url: `https://www.shopier.com/${id}` };
    products.set(id, created);
    return send(200, created);
  }
  if (u.pathname === '/v1/webhooks' && method === 'GET') return send(200, []);
  if (u.pathname === '/v1/webhooks' && method === 'POST') return send(200, { id: 'wh1', ...body, token: 'secret-token' });
  return send(404, { error: 'unmocked ' + method + ' ' + u.pathname });
};

let env;
const ORIGIN = 'https://www.noktaayakkabicilik.com';
const ctx = () => { const jobs = []; return { jobs, waitUntil: p => jobs.push(p) }; };
const checkout = (items, origin = ORIGIN, ip = '1.2.3.4') => worker.fetch(new Request('https://nokta-checkout.example.workers.dev/checkout', {
  method: 'POST', headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ items })
}), env, ctx());

beforeEach(() => {
  calls = [];
  nextId = 900000;
  products = new Map([
    ['51724140', product('51724140', 'Nike Dunk Low Pro White (36-45)', 1249, { 40: 3, 42: 0, 43: 2 })],
    ['51724107', product('51724107', 'Nike Airforce 1 Black (36-45)', 1650, { 41: 2, 44: 1 }, { priceData: { currency: 'TRY', price: '1650', discount: true, discountedPrice: '1400', vatPercent: '20' } })]
  ]);
  env = { DB: makeD1(), SHOPIER_PAT: 'pat-test', ADMIN_KEY: 'admin-test', STOCK_SYNC: 'on' };
});

test('iki ürünlük sepetten tek gizli Shopier ürünü oluşturur, fiyatı sunucu hesaplar', async () => {
  const res = await checkout([
    { shopierId: '51724140', size: '40', qty: 1, price: 1 },
    { shopierId: '51724107', size: '41', qty: 1 }
  ]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const data = await res.json();
  assert.equal(data.total, 1249 + 1400, 'indirimli fiyat kullanılmalı, istemcinin fiyatı yok sayılmalı');
  assert.match(data.url, /^https:\/\/www\.shopier\.com\/9000\d\d$/);
  const post = calls.find(c => c.method === 'POST' && c.path === '/v1/products');
  assert.equal(post.auth, 'Bearer pat-test');
  assert.equal(post.body.customListing, true);
  assert.equal(post.body.stockQuantity, 1);
  assert.equal(post.body.priceData.price, '2649.00');
  assert.ok(post.body.title.length <= 100, 'Shopier ürün başlığı en fazla 100 karakter');
  assert.strictEqual(post.body.priceData.vatPercent, 20, 'Shopier KDV oranını sayı olarak bekliyor');
  assert.equal(post.body.media.length, 2);
  assert.match(post.body.title, /^Nokta Sepeti · 2 çift · /);
  assert.match(post.body.description, /Nike Dunk Low Pro White \(36-45\) — 40 numara — 1 adet/);
});

test('aynı sepet tekrar gönderilirse yeni ürün açmaz, aynı linki verir', async () => {
  const items = [{ shopierId: '51724140', size: '40', qty: 2 }];
  const a = await (await checkout(items)).json();
  const b = await (await checkout(items)).json();
  assert.equal(a.url, b.url);
  assert.equal(b.reused, true);
  assert.equal(calls.filter(c => c.method === 'POST' && c.path === '/v1/products').length, 1);
});

test('tükenen numara ve olmayan numara reddedilir', async () => {
  let res = await checkout([{ shopierId: '51724140', size: '42', qty: 1 }]);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /42 numara tükendi/);
  res = await checkout([{ shopierId: '51724140', size: '38', qty: 1 }]);
  assert.equal(res.status, 409);
  res = await checkout([{ shopierId: '51724107', size: '44', qty: 2 }]);
  assert.equal(res.status, 409, 'stok 1 iken 2 adet alınamaz');
});

test('geçersiz girişler ve yabancı kaynak reddedilir', async () => {
  assert.equal((await checkout([])).status, 400);
  assert.equal((await checkout([{ shopierId: 'abc', size: '40', qty: 1 }])).status, 400);
  assert.equal((await checkout([{ shopierId: '51724140', size: '40', qty: 99 }])).status, 400);
  assert.equal((await checkout([{ shopierId: '51724140', size: '40', qty: 1 }], 'https://evil.example')).status, 403);
  assert.equal((await checkout([{ shopierId: '99999999', size: '40', qty: 1 }])).status, 409);
});

test('gizli paket ürünü sepete konamaz', async () => {
  const { url } = await (await checkout([{ shopierId: '51724140', size: '40', qty: 1 }])).json();
  const bundleId = url.split('/').pop();
  const res = await checkout([{ shopierId: bundleId, size: '40', qty: 1 }]);
  assert.equal(res.status, 400);
});

test('IP başına saatlik sınır çalışır', async () => {
  env.IP_HOURLY_CAP = '2';
  assert.equal((await checkout([{ shopierId: '51724140', size: '40', qty: 1 }])).status, 200);
  assert.equal((await checkout([{ shopierId: '51724140', size: '43', qty: 1 }])).status, 200);
  assert.equal((await checkout([{ shopierId: '51724107', size: '41', qty: 1 }])).status, 429);
  assert.equal((await checkout([{ shopierId: '51724107', size: '41', qty: 1 }], ORIGIN, '9.9.9.9')).status, 200);
});

test('PAT yoksa anlaşılır hata döner', async () => {
  delete env.SHOPIER_PAT;
  const res = await checkout([{ shopierId: '51724140', size: '40', qty: 1 }]);
  assert.equal(res.status, 503);
});

const admin = (path, method = 'GET', key = 'admin-test') => worker.fetch(new Request('https://nokta-checkout.example.workers.dev' + path, { method, headers: { 'x-admin-key': key } }), env, ctx());

test('yönetim uçları anahtarsız görünmez; webhook kurulumu token saklar', async () => {
  assert.equal((await admin('/admin/setup-webhook', 'POST', 'wrong')).status, 404);
  const res = await admin('/admin/setup-webhook', 'POST');
  assert.equal(res.status, 200);
  const sub = calls.find(c => c.method === 'POST' && c.path === '/v1/webhooks');
  assert.deepEqual(sub.body, { event: 'order.created', url: 'https://nokta-checkout.example.workers.dev/webhooks/shopier' });
  const row = env.DB.raw.prepare("SELECT value FROM checkout_settings WHERE key='webhook_token'").get();
  assert.equal(row.value, 'secret-token');
  const p = await (await admin('/admin/product?id=51724140')).json();
  assert.equal(p.price, 1249);
});

async function signedWebhook(body, { token = 'secret-token', id = 'd1', event = 'order.created', encoding = 'hex' } = {}) {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const sig = encoding === 'hex' ? [...mac].map(b => b.toString(16).padStart(2, '0')).join('') : btoa(String.fromCharCode(...mac));
  const c = ctx();
  const res = await worker.fetch(new Request('https://nokta-checkout.example.workers.dev/webhooks/shopier', {
    method: 'POST', headers: { 'shopier-signature': sig, 'shopier-event': event, 'shopier-webhook-id': id, 'content-type': 'application/json' }, body: raw
  }), env, c);
  await Promise.all(c.jobs);
  return res;
}

test('imzalı sipariş bildirimi paketi ödendi yapar ve gerçek stoğu düşer', async () => {
  await admin('/admin/setup-webhook', 'POST');
  const { url } = await (await checkout([
    { shopierId: '51724140', size: '40', qty: 2 },
    { shopierId: '51724107', size: '41', qty: 1 }
  ])).json();
  const bundleId = url.split('/').pop();
  const order = { id: 'o1', lineItems: [{ productId: bundleId, quantity: 1 }] };

  assert.equal((await signedWebhook(order, { token: 'wrong' })).status, 401);
  assert.equal((await signedWebhook(order)).status, 200);
  const row = env.DB.raw.prepare('SELECT status, order_id FROM checkout_bundles WHERE product_id = ?').get(bundleId);
  assert.deepEqual({ ...row }, { status: 'paid', order_id: 'o1' });
  const dunk = products.get('51724140').variants;
  assert.deepEqual(dunk.map(v => v.stockQuantity), [1, 0, 2], 'sadece 40 numara 2 azalmalı');
  assert.deepEqual(dunk.map(v => v.selectionId), [['s40'], ['s42'], ['s43']]);
  assert.deepEqual(products.get('51724107').variants.map(v => v.stockQuantity), [1, 1]);

  // aynı bildirim tekrar gelirse stok ikinci kez düşmez
  assert.equal((await signedWebhook(order)).status, 200);
  assert.deepEqual(products.get('51724140').variants.map(v => v.stockQuantity), [1, 0, 2]);
  // base64 imza da kabul edilir (farklı teslim kimliğiyle; paket zaten ödendi, değişiklik olmaz)
  assert.equal((await signedWebhook(order, { id: 'd2', encoding: 'b64' })).status, 200);
});

test('STOCK_SYNC kapalıyken stok değişmez', async () => {
  env.STOCK_SYNC = 'off';
  await admin('/admin/setup-webhook', 'POST');
  const { url } = await (await checkout([{ shopierId: '51724140', size: '40', qty: 1 }])).json();
  await signedWebhook({ id: 'o2', lineItems: [{ productId: url.split('/').pop() }] });
  assert.deepEqual(products.get('51724140').variants.map(v => v.stockQuantity), [3, 0, 2]);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 0);
});

test('süresi dolan ödenmemiş paketler silinir, ödenenler kalır', async () => {
  const a = await (await checkout([{ shopierId: '51724140', size: '40', qty: 1 }])).json();
  const b = await (await checkout([{ shopierId: '51724140', size: '43', qty: 1 }])).json();
  const old = Math.floor(Date.now() / 1000) - 25 * 3600;
  env.DB.raw.prepare('UPDATE checkout_bundles SET created_at = ?').run(old);
  env.DB.raw.prepare("UPDATE checkout_bundles SET status = 'paid' WHERE url = ?").run(b.url);
  const c = ctx();
  await worker.scheduled({}, env, c);
  await Promise.all(c.jobs);
  assert.equal(products.has(a.url.split('/').pop()), false);
  assert.equal(products.has(b.url.split('/').pop()), true);
  const statuses = env.DB.raw.prepare('SELECT status FROM checkout_bundles ORDER BY url').all().map(r => r.status);
  assert.deepEqual(statuses.sort(), ['expired', 'paid']);
});
