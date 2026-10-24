// Nokta "Kombininde Dene" sunucusu — Cloudflare Workers (ücretsiz plan).
// Firebase Cloud Functions'taki tryOn fonksiyonunun birebir karşılığı:
// CORS, Firebase oturum doğrulaması, kotalar (D1) ve FASHN çağrısı.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import products from './products.json';

const FIREBASE_PROJECT_ID = 'nokta-ayakkabicilik-ai-1453';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const jwksCache = new Map();
// JWKS_URL yalnızca yerel testte kullanılır; canlıda tanımlı değil.
const jwksFor = env => {
  const url = env.JWKS_URL || GOOGLE_JWKS_URL;
  if (!jwksCache.has(url)) jwksCache.set(url, createRemoteJWKSet(new URL(url)));
  return jwksCache.get(url);
};
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_PERSON_IMAGE_CHARS = 7 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set([
  'https://www.noktaayakkabicilik.com',
  'https://noktaayakkabicilik.com',
  'http://localhost:8000'
]);
const productMap = new Map(products.map(p => [String(p.id), p]));

const cors = request => {
  const origin = request.headers.get('origin');
  const headers = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Device-Id, X-Firebase-AppCheck',
    'Access-Control-Max-Age': '3600'
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
};
const json = (request, status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors(request), 'Content-Type': 'application/json; charset=utf-8' }
});

const isDataImage = value => {
  if (typeof value !== 'string') return false;
  const match = /^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,/.exec(value.slice(0, 40));
  if (!match) return false;
  const payload = value.slice(match[0].length);
  if (payload.length < 32 || !/^[A-Za-z0-9+/=]+$/.test(payload)) return false;
  let head;
  try { head = atob(payload.slice(0, 16)); } catch { return false; }
  const hex = [...head].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  if (match[1] === 'png') return hex.startsWith('89504e470d0a1a0a');
  if (match[1] === 'jpeg' || match[1] === 'jpg') return hex.startsWith('ffd8');
  if (match[1] === 'webp') return head.startsWith('RIFF');
  return true;
};
const validShoeUrl = value => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      u.hostname === 'cdn.shopier.app' && u.pathname.startsWith('/pictures_large/noktaayakkabi_');
  } catch { return false; }
};

/* ---------- kota (D1) ---------- */
const quotaError = reason => Object.assign(new Error('quota'), { code: 'TRYON_QUOTA_EXCEEDED', reason });
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
const limits = env => ({
  registeredDailyLimit: num(env.REGISTERED_DAILY_LIMIT, 2),
  deviceDailyCap: num(env.DEVICE_DAILY_CAP, 3),
  anonIpDailyCap: num(env.ANON_IP_DAILY_CAP, 3),
  globalDailyCap: num(env.GLOBAL_DAILY_CAP, 14),
  globalTotalCap: num(env.GLOBAL_TOTAL_CAP, 100)
});
const hmac = async (salt, value) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(value)));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
};
const keysFor = r => ({
  anonUid: r.isAnonymous ? `anon_uid_${r.uidHash}` : null,
  deviceUsed: r.isAnonymous && r.deviceHash ? `device_${r.deviceHash}` : null,
  ip: r.isAnonymous ? `ip_${r.ipHash}_${r.dayKey}` : null,
  user: !r.isAnonymous ? `user_${r.uidHash}_${r.dayKey}` : null,
  deviceDaily: !r.isAnonymous && r.deviceHash ? `device_${r.deviceHash}_${r.dayKey}` : null,
  globalDaily: `global_${r.dayKey}`,
  globalTotal: 'global_total'
});
const readRows = async (db, keys) => {
  const list = Object.values(keys).filter(Boolean);
  const { results } = await db.prepare(`SELECT key, count, used FROM tryon_usage WHERE key IN (${list.map(() => '?').join(',')})`).bind(...list).all();
  const map = new Map(results.map(r => [r.key, r]));
  return k => (k && map.get(k)) || { count: 0, used: 0 };
};
const upsert = (db, key, count, used, expireAt) => db.prepare(
  'INSERT INTO tryon_usage (key, count, used, expire_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, used = excluded.used, expire_at = excluded.expire_at'
).bind(key, count, used, expireAt);

async function reserveUsage(env, { uid, ip, isAnonymous, deviceId }) {
  if (!env.HASH_SALT) throw Object.assign(new Error('HASH_SALT missing'), { code: 'failed-precondition' });
  const caps = limits(env);
  const now = Date.now();
  const dayKey = new Date(now).toISOString().slice(0, 10).replaceAll('-', '');
  const expireAt = now + 30 * 24 * 60 * 60 * 1000;
  const r = {
    dayKey, isAnonymous,
    uidHash: await hmac(env.HASH_SALT, uid),
    ipHash: await hmac(env.HASH_SALT, ip),
    deviceHash: deviceId ? await hmac(env.HASH_SALT, deviceId) : ''
  };
  const k = keysFor(r);
  const get = await readRows(env.DB, k);
  if (get(k.globalTotal).count >= caps.globalTotalCap) throw quotaError('QUOTA_EXHAUSTED');
  if (get(k.globalDaily).count >= caps.globalDailyCap) throw quotaError('GLOBAL_CAP');
  if (isAnonymous) {
    if (get(k.anonUid).used || get(k.deviceUsed).used) throw quotaError('ANONYMOUS_TRIAL_USED');
    if (get(k.ip).count >= caps.anonIpDailyCap) throw quotaError('ANONYMOUS_TRIAL_USED');
  } else {
    if (get(k.user).count >= caps.registeredDailyLimit) throw quotaError('DAILY_LIMIT');
    if (k.deviceDaily && get(k.deviceDaily).count >= caps.deviceDailyCap) throw quotaError('DAILY_LIMIT');
  }
  const ops = [];
  if (k.anonUid) ops.push(upsert(env.DB, k.anonUid, 0, 1, expireAt));
  if (k.deviceUsed) ops.push(upsert(env.DB, k.deviceUsed, 0, 1, expireAt));
  for (const name of ['ip', 'user', 'deviceDaily', 'globalDaily']) {
    if (k[name]) ops.push(upsert(env.DB, k[name], get(k[name]).count + 1, 0, expireAt));
  }
  ops.push(upsert(env.DB, k.globalTotal, get(k.globalTotal).count + 1, 0, null));
  ops.push(env.DB.prepare('DELETE FROM tryon_usage WHERE expire_at IS NOT NULL AND expire_at < ?').bind(now));
  await env.DB.batch(ops);
  return r;
}
async function refundUsage(env, r) {
  if (!r || !r.dayKey) return;
  const k = keysFor(r);
  const ops = [];
  if (k.anonUid) ops.push(env.DB.prepare('UPDATE tryon_usage SET used = 0 WHERE key = ?').bind(k.anonUid));
  if (k.deviceUsed) ops.push(env.DB.prepare('UPDATE tryon_usage SET used = 0 WHERE key = ?').bind(k.deviceUsed));
  for (const name of ['ip', 'user', 'deviceDaily', 'globalDaily', 'globalTotal']) {
    if (k[name]) ops.push(env.DB.prepare('UPDATE tryon_usage SET count = count - 1 WHERE key = ? AND count > 0').bind(k[name]));
  }
  await env.DB.batch(ops);
}
async function markGlobalTotalExhausted(env) {
  const cap = limits(env).globalTotalCap;
  await env.DB.prepare('INSERT INTO tryon_usage (key, count, used, expire_at) VALUES (\'global_total\', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET count = MAX(count, excluded.count)').bind(cap).run();
}

/* ---------- FASHN ---------- */
const isProviderQuotaError = (status, message) => {
  const t = String(message || '').toLowerCase();
  return Number(status) === 429 || t.includes('resource_exhausted') || t.includes('quota') || t.includes('rate limit') || t.includes('rate_limit');
};
const isPermanentProviderQuota = message => {
  const t = String(message || '').toLowerCase();
  return ['resource_exhausted', 'quota exhausted', 'quota exceeded', 'capacity exhausted', 'daily quota exceeded'].some(s => t.includes(s));
};
// Sonuç ~1-2 MB base64 olabilir; ücretsiz planın CPU sınırına takılmamak için büyük yanıtı
// JSON.parse etmeden, yalnızca metin aramasıyla çözüyoruz.
const readStatus = async response => {
  const text = await response.text();
  if (text.length < 64 * 1024) {
    try { return JSON.parse(text); } catch { return {}; }
  }
  if (!/"status"\s*:\s*"completed"/.test(text.slice(0, 4096)) && text.indexOf('"status":"completed"') === -1) return { status: 'unknown' };
  const start = text.indexOf('"output"');
  const q1 = text.indexOf('"', text.indexOf('[', start) + 1);
  const q2 = text.indexOf('"', q1 + 1);
  if (start < 0 || q1 < 0 || q2 < 0) return { status: 'unknown' };
  return { status: 'completed', output: [text.slice(q1 + 1, q2)], raw: true };
};

async function handleTryOn(request, env, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== 'POST') return json(request, 405, { error: 'Yalnızca POST desteklenir.' });

  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) return json(request, 401, { error: 'Oturum gerekli.' });
  let token;
  try {
    ({ payload: token } = await jwtVerify(authorization.slice(7), jwksFor(env), {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID
    }));
    if (!token.sub) throw new Error('no sub');
  } catch {
    return json(request, 401, { error: 'Geçersiz oturum.' });
  }
  const isAnonymous = token.firebase?.sign_in_provider === 'anonymous';
  if (!token.email_verified && !isAnonymous) return json(request, 403, { error: 'E-posta doğrulaması gerekli.' });

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_REQUEST_BYTES) return json(request, 413, { error: 'İstek boyutu sınırı aşıldı.' });
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_REQUEST_BYTES) return json(request, 413, { error: 'İstek boyutu sınırı aşıldı.' });
    body = JSON.parse(text);
  } catch {
    return json(request, 400, { error: 'İstek biçimi geçersiz.' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(request, 413, { error: 'İstek boyutu sınırı aşıldı.' });
  const { personImage, productId } = body;
  const product = productMap.get(String(productId));
  if (typeof personImage !== 'string' || personImage.length > MAX_PERSON_IMAGE_CHARS || !isDataImage(personImage)) {
    return json(request, 400, { error: 'Fotoğraf geçersiz veya izin verilen boyutu aşıyor.' });
  }
  if (!product || !validShoeUrl(product.image)) return json(request, 400, { error: 'Ayakkabı görseli geçersiz.' });

  let reservation;
  try {
    reservation = await reserveUsage(env, {
      uid: token.sub,
      ip: request.headers.get('cf-connecting-ip') || 'unknown',
      isAnonymous,
      deviceId: request.headers.get('x-device-id') || ''
    });
  } catch (error) {
    if (error.code === 'TRYON_QUOTA_EXCEEDED') {
      return json(request, error.reason === 'GLOBAL_CAP' || error.reason === 'QUOTA_EXHAUSTED' ? 503 : 429, { error: error.reason });
    }
    console.error('[TryOn] Usage quota unavailable', error.message);
    return json(request, 503, { error: 'AI servisi şu anda kullanılamıyor.' });
  }
  const refund = async () => { try { await refundUsage(env, reservation); } catch (e) { console.error('[TryOn] refund failed', e.message); } };

  const base = env.FASHN_BASE_URL || 'https://api.fashn.ai';
  const deadline = Date.now() + 100000;
  try {
    if (!env.FASHN_API_KEY) throw new Error('AI service unavailable');
    const selectedShoe = String(product.title || 'seçilen ayakkabı').replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/[^\p{L}\p{N} .\-()]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const runResponse = await fetch(`${base}/v1/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.FASHN_API_KEY}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        model_name: 'tryon-max',
        inputs: {
          // Ayakkabı görselini FASHN kendisi indiriyor (Shopier adresi, yukarıda doğrulandı).
          product_image: product.image,
          model_image: personImage,
          prompt: `Place the exact selected shoe, ${selectedShoe}, naturally on the person's visible feet. Match the product image precisely, including its silhouette, colorway and details. Estimate the person's foot length and width from the visible feet, ankles, legs and perspective, then scale the shoe to fit the foot naturally. The shoe must sit inside the foot outline, follow the foot angle and perspective, and never look oversized, floating or wider than the foot. Keep both shoes at a consistent realistic scale. Do not replace it with an Air Force 1 or any other shoe. Preserve the person's identity, pose, lighting, shadows and the rest of the outfit.`,
          resolution: '1k',
          generation_mode: 'fast',
          num_images: 1,
          output_format: 'png',
          return_base64: true
        }
      })
    });
    const runResult = await runResponse.json().catch(() => ({}));
    if (!runResponse.ok || !runResult.id) {
      const msg = typeof runResult.error === 'string' ? runResult.error : runResult.error?.message || 'FASHN run request failed';
      throw Object.assign(new Error(isProviderQuotaError(runResponse.status, msg) ? msg : 'FASHN run request failed'), { status: runResponse.status });
    }
    for (let attempt = 0; attempt < 34; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(r => setTimeout(r, Math.min(Number(env.POLL_MS || 3000), remaining)));
      const statusResponse = await fetch(`${base}/v1/status/${encodeURIComponent(runResult.id)}`, {
        headers: { Authorization: `Bearer ${env.FASHN_API_KEY}` },
        signal: AbortSignal.timeout(Math.min(15000, Math.max(1, deadline - Date.now())))
      });
      const s = await readStatus(statusResponse);
      if (s.status === 'completed' && s.output?.[0]) {
        if (s.raw) {
          return new Response(`{"imageUrl":"${s.output[0]}"}`, { status: 200, headers: { ...cors(request), 'Content-Type': 'application/json; charset=utf-8' } });
        }
        return json(request, 200, { imageUrl: s.output[0] });
      }
      if (!statusResponse.ok || s.status === 'failed' || s.error) {
        const msg = typeof s.error === 'string' ? s.error : s.error?.message || 'FASHN status request failed';
        throw Object.assign(new Error(msg), { status: statusResponse.status });
      }
    }
    await refund();
    return json(request, 504, { error: 'AI işlemi zaman aşımına uğradı.' });
  } catch (error) {
    await refund();
    const status = error?.status || null;
    const message = String(error?.message || 'Unknown provider error').slice(0, 500);
    console.error('[TryOn] AI provider request failed', status, message);
    if (isProviderQuotaError(status, message)) {
      if (isPermanentProviderQuota(message)) {
        try { await markGlobalTotalExhausted(env); } catch (e) { console.error('[TryOn] mark failed', e.message); }
      }
      return json(request, 503, { error: 'QUOTA_EXHAUSTED' });
    }
    if (Date.now() >= deadline) return json(request, 504, { error: 'AI işlemi zaman aşımına uğradı.' });
    return json(request, 502, { error: 'AI servisi şu anda yanıt veremiyor.' });
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleTryOn(request, env, ctx);
    } catch (error) {
      console.error('[TryOn] Unhandled', error?.message);
      return json(request, 500, { error: 'Sunucu hatası.' });
    }
  }
};
