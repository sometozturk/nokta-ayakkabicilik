// Nokta "Tek ödemede sepet" sunucusu — Cloudflare Workers.
//
// Shopier'de bir sepeti dışarıdan doldurmanın yolu yok. Bunun yerine sitedeki sepet
// için Shopier API'siyle mağazada görünmeyen (customListing) tek bir "Nokta Sepeti"
// ürünü oluşturuyoruz; fiyatı sepet toplamı, açıklaması ürün + numara listesi.
// Müşteri bu ürünün Shopier sayfasına gidip tek seferde öder.
//
//   POST /checkout              sepetten paket ürün oluşturur, Shopier linkini döner
//   POST /webhooks/shopier      order.created bildirimi: paketi "ödendi" işaretler
//   POST /admin/setup-webhook   (X-Admin-Key) order.created aboneliğini kurar
//   GET  /admin/product?id=     (X-Admin-Key) API'nin ürünü nasıl gördüğünü gösterir
//   cron                        ödenmeyen paketleri BUNDLE_TTL_HOURS sonra siler
//
// Gizli değişkenler (wrangler secret): SHOPIER_PAT, ADMIN_KEY

const API = 'https://api.shopier.com/v1';
const ALLOWED_ORIGINS = new Set([
  'https://www.noktaayakkabicilik.com',
  'https://noktaayakkabicilik.com',
  'http://localhost:8000'
]);
const MAX_LINES = 8;
const MAX_QTY = 5;
const MAX_BODY_BYTES = 8 * 1024;

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const settings = env => ({
  ttlHours: num(env.BUNDLE_TTL_HOURS, 24),
  reuseMinutes: num(env.BUNDLE_REUSE_MINUTES, 120),
  ipHourlyCap: num(env.IP_HOURLY_CAP, 12),
  dailyCap: num(env.DAILY_CAP, 300),
  stockSync: env.STOCK_SYNC === 'on'
});

/* ---------- yardımcılar ---------- */
const cors = request => {
  const origin = request.headers.get('origin');
  const headers = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '3600'
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
};
const json = (request, status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors(request), 'Content-Type': 'application/json; charset=utf-8' }
});
const now = () => Math.floor(Date.now() / 1000);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async text => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const hmacBytes = async (secret, text) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
};
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
const money = n => Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' TL';
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/* ---------- Shopier API ---------- */
async function shopier(env, method, path, body) {
  if (!env.SHOPIER_PAT) throw httpError(503, 'Ödeme sistemi henüz yapılandırılmadı.', 'NOT_CONFIGURED');
  const response = await fetch(API + path, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${env.SHOPIER_PAT}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const err = httpError(response.status, `Shopier API ${method} ${path} → ${response.status}`, 'SHOPIER_API');
    err.detail = data;
    throw err;
  }
  return data;
}

// Ürünün o anki satış fiyatı (indirimdeyse indirimli fiyat).
const unitPrice = product => {
  const p = product.priceData || {};
  const discounted = Number(p.discountedPrice);
  if (p.discount && Number.isFinite(discounted) && discounted > 0) return discounted;
  return Number(p.price);
};
// Numara varyantını bulur; selectionTitle bir dizi (her varyasyon grubu için bir seçim).
const findVariant = (product, size) => (product.variants || []).find(v =>
  [].concat(v.selectionTitle || []).some(t => clean(t) === size));
const variantInStock = (v, qty) => v && v.stockStatus !== 'outOfStock' && (v.stockQuantity === undefined || Number(v.stockQuantity) >= qty);

/* ---------- D1 ---------- */
async function bumpCounter(env, key, ttlSeconds, cap) {
  const t = now();
  await env.DB.prepare('DELETE FROM checkout_rate WHERE key = ? AND expire_at <= ?').bind(key, t).run();
  await env.DB.prepare(
    'INSERT INTO checkout_rate (key, count, expire_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1'
  ).bind(key, t + ttlSeconds).run();
  const row = await env.DB.prepare('SELECT count FROM checkout_rate WHERE key = ?').bind(key).first();
  return (row?.count || 0) <= cap;
}
const getSetting = async (env, key) => (await env.DB.prepare('SELECT value FROM checkout_settings WHERE key = ?').bind(key).first())?.value || null;
const setSetting = (env, key, value) => env.DB.prepare(
  'INSERT INTO checkout_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).bind(key, value).run();

/* ---------- sepeti doğrula ---------- */
function parseCart(body) {
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || !items.length) throw httpError(400, 'Sepet boş.', 'EMPTY');
  const merged = new Map();
  for (const raw of items) {
    const id = clean(raw?.shopierId);
    const size = clean(raw?.size);
    const qty = Math.floor(Number(raw?.qty));
    if (!/^\d{4,12}$/.test(id) || !/^[0-9]{2}(\.5)?$/.test(size) || !(qty >= 1 && qty <= MAX_QTY)) {
      throw httpError(400, 'Sepette geçersiz bir ürün var.', 'BAD_ITEM');
    }
    const key = `${id}:${size}`;
    merged.set(key, { shopierId: id, size, qty: Math.min(MAX_QTY, (merged.get(key)?.qty || 0) + qty) });
  }
  if (merged.size > MAX_LINES) throw httpError(400, `Tek seferde en fazla ${MAX_LINES} farklı ürün alınabilir.`, 'TOO_MANY');
  return [...merged.values()].sort((a, b) => (a.shopierId + a.size).localeCompare(b.shopierId + b.size));
}

async function priceCart(env, cart) {
  const products = new Map();
  for (const line of cart) {
    if (!products.has(line.shopierId)) {
      try {
        products.set(line.shopierId, await shopier(env, 'GET', `/products/${line.shopierId}`));
      } catch (err) {
        if (err.status === 404) throw httpError(409, 'Sepetindeki bir ürün artık satışta değil.', 'GONE');
        throw err;
      }
    }
  }
  const lines = cart.map(line => {
    const product = products.get(line.shopierId);
    if (product.customListing) throw httpError(400, 'Sepette geçersiz bir ürün var.', 'BAD_ITEM');
    const price = unitPrice(product);
    if (!(price > 0)) throw httpError(409, 'Bir ürünün fiyatı okunamadı.', 'PRICE');
    if (product.variants?.length) {
      const variant = findVariant(product, line.size);
      if (!variant) throw httpError(409, `${clean(product.title)} için ${line.size} numara bulunamadı.`, 'SIZE');
      if (!variantInStock(variant, line.qty)) throw httpError(409, `${clean(product.title)} ${line.size} numara tükendi.`, 'STOCK');
    } else if (product.stockStatus === 'outOfStock') {
      throw httpError(409, `${clean(product.title)} tükendi.`, 'STOCK');
    }
    return { ...line, title: clean(product.title), price, image: product.media?.[0]?.url || null, vat: product.priceData?.vatPercent };
  });
  const total = Math.round(lines.reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100;
  return { lines, total };
}

function bundleBody({ lines, total }, code) {
  const pairs = lines.reduce((s, l) => s + l.qty, 0);
  const summary = lines.map(l => `${l.title.replace(/\s*\(\d{2}\s*-\s*\d{2}\)\s*$/, '')} ${l.size}${l.qty > 1 ? ` x${l.qty}` : ''}`).join(' + ');
  let title = `Nokta Sepeti · ${pairs} çift · ${summary}`;
  if (title.length > 120) title = title.slice(0, 117) + '…';
  const description = [
    `Sepet kodu: ${code}`,
    '',
    'Sepetindeki ürünler:',
    ...lines.map((l, i) => `${i + 1}) ${l.title} — ${l.size} numara — ${l.qty} adet — ${money(l.price * l.qty)}`),
    '',
    `Toplam: ${money(total)}`,
    '',
    'Bu sayfa, noktaayakkabicilik.com sepetindeki ürünlerin tek seferde ödenmesi içindir.',
    '14 gün iade ve değişim · Saat 17:00\'ye kadar verilen siparişler aynı gün kargoda.'
  ].join('\n');
  const images = [...new Set(lines.map(l => l.image).filter(Boolean))].slice(0, 5);
  const vat = lines.find(l => l.vat)?.vat;
  return {
    title,
    description,
    type: 'physical',
    media: images.map((url, i) => ({ type: 'image', url, placement: i + 1 })),
    priceData: { currency: 'TRY', price: total.toFixed(2), ...(vat ? { vatPercent: String(vat) } : {}) },
    stockQuantity: 1,
    shippingPayer: 'sellerPays',
    customListing: true,
    dispatchDuration: 1
  };
}

async function handleCheckout(request, env) {
  const cfg = settings(env);
  const origin = request.headers.get('origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return json(request, 403, { error: 'İzin verilmeyen kaynak.' });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(request, 413, { error: 'İstek çok büyük.' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(request, 400, { error: 'Geçersiz istek.' }); }

  const cart = parseCart(body);
  const cartHash = await sha256(JSON.stringify(cart));

  // Aynı sepet kısa süre önce paketlendiyse aynı linki ver (yeni ürün açma).
  const reuseAfter = now() - cfg.reuseMinutes * 60;
  const existing = await env.DB.prepare(
    "SELECT product_id, url, total FROM checkout_bundles WHERE cart_hash = ? AND status = 'pending' AND created_at > ? ORDER BY created_at DESC LIMIT 1"
  ).bind(cartHash, reuseAfter).first();
  if (existing?.url) return json(request, 200, { url: existing.url, total: Number(existing.total), reused: true });

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const ipKey = 'ip_' + (await sha256('nokta-checkout:' + ip)).slice(0, 32);
  const day = new Date().toISOString().slice(0, 10);
  if (!(await bumpCounter(env, ipKey, 3600, cfg.ipHourlyCap))) {
    return json(request, 429, { error: 'Çok fazla deneme yapıldı, biraz sonra tekrar dene.' });
  }
  if (!(await bumpCounter(env, 'day_' + day, 86400 * 2, cfg.dailyCap))) {
    return json(request, 503, { error: 'Şu an sepet oluşturulamıyor, ürünleri tek tek Shopier\'den alabilirsin.' });
  }

  const priced = await priceCart(env, cart);
  const code = 'NS-' + cartHash.slice(0, 6).toUpperCase() + '-' + now().toString(36).toUpperCase();
  const product = await shopier(env, 'POST', '/products', bundleBody(priced, code));
  if (!product?.id || !product?.url) throw httpError(502, 'Shopier ürün linkini döndürmedi.', 'NO_URL');

  await env.DB.prepare(
    "INSERT INTO checkout_bundles (product_id, code, cart_hash, items, total, url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
  ).bind(String(product.id), code, cartHash, JSON.stringify(priced.lines.map(({ shopierId, size, qty, price, title }) => ({ shopierId, size, qty, price, title }))), String(priced.total), product.url, now()).run();

  return json(request, 200, { url: product.url, total: priced.total, code });
}

/* ---------- stok düşme (STOCK_SYNC=on iken) ---------- */
async function decrementStock(env, line) {
  const product = await shopier(env, 'GET', `/products/${line.shopierId}`);
  if (!product.variants?.length) {
    if (product.stockQuantity === undefined) return;
    await shopier(env, 'PUT', `/products/${line.shopierId}`, { stockQuantity: Math.max(0, Number(product.stockQuantity) - line.qty) });
    return;
  }
  const target = findVariant(product, line.size);
  if (!target) return;
  // PUT tüm varyant listesini bekler; diğer varyantları aynen geri gönderiyoruz.
  const variants = product.variants.map(v => ({
    selectionId: [].concat(v.selectionId || []),
    stockQuantity: v === target ? Math.max(0, Number(v.stockQuantity || 0) - line.qty) : Number(v.stockQuantity || 0),
    ...(v.priceData?.price ? { priceData: { currency: v.priceData.currency || 'TRY', price: String(v.priceData.price) } } : {}),
    ...(v.media?.length ? { media: v.media.map(m => ({ type: 'image', url: m.url })) } : {}),
    ...(v.primary !== undefined ? { primary: Boolean(v.primary) } : {})
  }));
  await shopier(env, 'PUT', `/products/${line.shopierId}`, { variants });
}

/* ---------- webhook ---------- */
async function verifySignature(env, raw, signature) {
  const token = await getSetting(env, 'webhook_token');
  if (!token || !signature) return false;
  const mac = await hmacBytes(token, raw);
  const asHex = hex(mac);
  const asB64 = btoa(String.fromCharCode(...mac));
  const sig = signature.trim().replace(/^sha256=/i, '');
  return safeEqual(sig.toLowerCase(), asHex) || safeEqual(sig, asB64);
}

async function processOrder(env, order) {
  const cfg = settings(env);
  for (const item of order?.lineItems || []) {
    const bundle = await env.DB.prepare("SELECT * FROM checkout_bundles WHERE product_id = ? AND status = 'pending'").bind(String(item.productId)).first();
    if (!bundle) continue;
    await env.DB.prepare("UPDATE checkout_bundles SET status = 'paid', order_id = ?, paid_at = ? WHERE product_id = ?")
      .bind(String(order.id || ''), now(), bundle.product_id).run();
    if (cfg.stockSync) {
      for (const line of JSON.parse(bundle.items)) {
        try { await decrementStock(env, line); } catch (err) { console.error('stock', line.shopierId, err.message, JSON.stringify(err.detail || {})); }
      }
    }
  }
}

async function handleWebhook(request, env, ctx) {
  const raw = await request.text();
  if (!(await verifySignature(env, raw, request.headers.get('shopier-signature')))) {
    return new Response('invalid signature', { status: 401 });
  }
  const event = request.headers.get('shopier-event');
  const deliveryId = request.headers.get('shopier-webhook-id') || '';
  if (event !== 'order.created') return new Response('ignored', { status: 200 });
  if (deliveryId) {
    const seen = await env.DB.prepare('SELECT 1 FROM checkout_rate WHERE key = ?').bind('wh_' + deliveryId).first();
    if (seen) return new Response('duplicate', { status: 200 });
    await env.DB.prepare('INSERT OR IGNORE INTO checkout_rate (key, count, expire_at) VALUES (?, 1, ?)').bind('wh_' + deliveryId, now() + 86400 * 5).run();
  }
  let order;
  try { order = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  // Shopier 5 saniye içinde 200 bekliyor; işi arka planda yap.
  ctx.waitUntil(processOrder(env, order).catch(err => console.error('order', err.message)));
  return new Response('ok', { status: 200 });
}

/* ---------- yönetim ---------- */
const isAdmin = (request, env) => Boolean(env.ADMIN_KEY) && safeEqual(request.headers.get('x-admin-key') || '', env.ADMIN_KEY);

async function handleAdmin(request, env, url) {
  if (!isAdmin(request, env)) return new Response('not found', { status: 404 });
  const reply = (status, body) => new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  if (url.pathname === '/admin/product' && request.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    if (!/^\d{4,12}$/.test(id)) return reply(400, { error: 'id' });
    const p = await shopier(env, 'GET', `/products/${id}`);
    return reply(200, { id: p.id, title: p.title, url: p.url, price: unitPrice(p), stockStatus: p.stockStatus, stockQuantity: p.stockQuantity,
      variants: (p.variants || []).map(v => ({ size: v.selectionTitle, stockQuantity: v.stockQuantity, stockStatus: v.stockStatus })) });
  }
  if (url.pathname === '/admin/setup-webhook' && request.method === 'POST') {
    const target = `${url.origin}/webhooks/shopier`;
    const list = await shopier(env, 'GET', '/webhooks');
    const subs = Array.isArray(list) ? list : (list?.data || list?.items || []);
    const old = subs.find(w => w.event === 'order.created' && w.url === target);
    if (old && (await getSetting(env, 'webhook_token'))) return reply(200, { ok: true, already: true, id: old.id });
    if (old) await shopier(env, 'DELETE', `/webhooks/${old.id}`);
    const created = await shopier(env, 'POST', '/webhooks', { event: 'order.created', url: target });
    if (!created?.token) return reply(502, { error: 'Shopier webhook token döndürmedi', created });
    await setSetting(env, 'webhook_token', created.token);
    await setSetting(env, 'webhook_id', String(created.id || ''));
    return reply(200, { ok: true, id: created.id, url: target });
  }
  if (url.pathname === '/admin/bundles' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT product_id, code, total, status, order_id, created_at, paid_at, url FROM checkout_bundles ORDER BY created_at DESC LIMIT 50').all();
    return reply(200, rows.results || []);
  }
  return new Response('not found', { status: 404 });
}

/* ---------- temizlik ---------- */
async function cleanup(env) {
  const cfg = settings(env);
  const cutoff = now() - cfg.ttlHours * 3600;
  const rows = await env.DB.prepare("SELECT product_id FROM checkout_bundles WHERE status = 'pending' AND created_at < ? LIMIT 50").bind(cutoff).all();
  for (const row of rows.results || []) {
    try {
      await shopier(env, 'DELETE', `/products/${row.product_id}`);
    } catch (err) {
      if (err.status !== 404) { console.error('cleanup', row.product_id, err.message); continue; }
    }
    await env.DB.prepare("UPDATE checkout_bundles SET status = 'expired' WHERE product_id = ? AND status = 'pending'").bind(row.product_id).run();
  }
  await env.DB.prepare('DELETE FROM checkout_rate WHERE expire_at <= ?').bind(now()).run();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/checkout') {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
        if (request.method !== 'POST') return json(request, 405, { error: 'Yalnızca POST desteklenir.' });
        return await handleCheckout(request, env);
      }
      if (url.pathname === '/webhooks/shopier' && request.method === 'POST') return await handleWebhook(request, env, ctx);
      if (url.pathname.startsWith('/admin/')) return await handleAdmin(request, env, url);
      return new Response('Nokta checkout', { status: 200 });
    } catch (err) {
      console.error('error', err.code || '', err.message, JSON.stringify(err.detail || {}));
      if (url.pathname.startsWith('/admin/') && isAdmin(request, env)) {
        return new Response(JSON.stringify({ error: err.message, status: err.status, detail: err.detail || null }, null, 2), { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } });
      }
      const status = err.status && err.code !== 'SHOPIER_API' ? err.status : 502;
      const message = err.code && err.code !== 'SHOPIER_API' ? err.message : 'Sepet şu an oluşturulamadı. Ürünleri tek tek Shopier\'den alabilirsin.';
      return json(request, status, { error: message, code: err.code || 'ERROR' });
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  }
};

// Testler için.
export const _internal = { parseCart, priceCart, bundleBody, findVariant, unitPrice, decrementStock, cleanup, processOrder };
