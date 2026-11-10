#!/usr/bin/env node
/*
 * Shopier kataloğunu resmi API (api.shopier.com/v1) üzerinden products.json'a senkronlar.
 * Mağaza sayfalarını tarayan eski yöntem (sync_shopier.js) GitHub sunucularında Cloudflare
 * engeline takıldığı için bu betik onun yerine kullanılır.
 *
 * Kullanım:
 *   SHOPIER_PAT=... node scripts/sync-shopier-api.mjs           # products.json'u günceller
 *   SHOPIER_PAT=... node scripts/sync-shopier-api.mjs --check   # sadece bağlantıyı dener
 *
 * Depo herkese açık: kayıtlara ürün verisi ya da API yanıtı yazılmaz; sadece sayılar,
 * durum kodları ve alan adları yazılır.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.shopier.com/v1';
const STORE = 'https://www.shopier.com/noktaayakkabi';
const PAT = process.env.SHOPIER_PAT;
const CHECK = process.argv.includes('--check');

if (!PAT) {
    console.error('SHOPIER_PAT tanımlı değil.');
    process.exit(1);
}

async function api(path) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const res = await fetch(API + path, { headers: { accept: 'application/json', authorization: `Bearer ${PAT}` } });
        if (res.status === 429 || res.status >= 500) {
            await new Promise((r) => setTimeout(r, 2000 * attempt));
            continue;
        }
        const text = await res.text();
        if (!res.ok) throw new Error(`Shopier API GET ${path.split('?')[0]} -> ${res.status}`);
        return JSON.parse(text);
    }
    throw new Error(`Shopier API GET ${path.split('?')[0]} -> tekrar denemeler başarısız`);
}

const listOf = (data) => (Array.isArray(data) ? data : data?.data || data?.items || data?.products || []);

async function fetchAll() {
    const all = [];
    for (let page = 1; page <= 50; page += 1) {
        const items = listOf(await api(`/products?limit=50&page=${page}`));
        all.push(...items);
        if (items.length < 50) break;
        await new Promise((r) => setTimeout(r, 300));
    }
    return all;
}

// --- alan okuyucular (API alan adları değişse de dayanıklı olsun diye esnek) ---
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function collectStrings(value, out = []) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
    return out;
}

function imagesOf(p) {
    const urls = collectStrings(p.media ?? p.images ?? p.photos ?? p).filter((s) => /^https:\/\/[^\s"]*cdn\.shopier\.app\/pictures_(large|small)\//i.test(s));
    const unique = [...new Set(urls)];
    const large = unique.filter((u) => /pictures_large/i.test(u));
    return large.length ? large : unique.map((u) => u.replace('/pictures_small/', '/pictures_large/'));
}

function priceOf(p) {
    const d = p.priceData || {};
    const discounted = Number(d.discountedPrice);
    const value = d.discount && Number.isFinite(discounted) && discounted > 0 ? discounted : Number(d.price ?? p.price);
    if (!Number.isFinite(value) || value <= 0) return '';
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function sizeStockOf(p) {
    const variants = Array.isArray(p.variants) ? p.variants : [];
    const rows = variants.map((v) => ({
        size: clean([].concat(v.selectionTitle ?? v.title ?? v.name ?? '').join(' ')),
        stock: v.stockStatus === 'outOfStock' ? 0 : Math.max(0, Number(v.stockQuantity) || 0)
    })).filter((v) => v.size);
    return rows.length ? rows : undefined;
}

function stockOf(p, sizeStock) {
    if (sizeStock) return sizeStock.reduce((sum, v) => sum + v.stock, 0);
    if (p.stockStatus === 'outOfStock') return 0;
    const n = Number(p.stockQuantity);
    return Number.isFinite(n) ? n : undefined;
}

const isHidden = (p) => Boolean(p.customListing) || p.status === 'inactive' || p.isActive === false || p.active === false;
const shopierUrl = (p) => `${STORE}/${p.id}`;

// Sitenin kullandığı Shopier kategorileri; yeni ürünlerde önce Shopier'deki kategoriye bakılır.
const SITE_CATEGORIES = ['Topuklu Nokta Shic', 'Kadın Bot', 'Erkek Bot', 'Çocuk Sneakers'];
const shopierCategories = (p) => collectStrings(p.categories).map(clean).filter((c) => SITE_CATEGORIES.includes(c));

// sync_shopier.js ile aynı kategori kuralları
function getCategory(title, previousCategory = '', fromShopier = []) {
    if (previousCategory) return previousCategory;
    if (fromShopier.length) return fromShopier[0];
    if (/çocuk/i.test(title)) return 'Çocuk Sneakers';
    if (/\bbot\b|çizme/i.test(title)) return /kadın|topuklu|çizme|\bugg\b/i.test(title) ? 'Kadın Bot' : 'Erkek Bot';
    return '';
}
function getCategories(title, category, previous = []) {
    const list = [...new Set([...previous, category].filter(Boolean))];
    return list.length ? list : (getCategory(title) ? [getCategory(title)] : []);
}

const products = await fetchAll();

if (CHECK) {
    const first = products[0] || {};
    console.log(`API erişimi tamam. Ürün sayısı: ${products.length}`);
    console.log(`Gizli/özel (customListing) ürün: ${products.filter(isHidden).length}`);
    console.log(`Ürün alanları: ${Object.keys(first).join(', ')}`);
    console.log(`Fiyat alanları: ${Object.keys(first.priceData || {}).join(', ')}`);
    console.log(`Varyant alanları: ${Object.keys((first.variants || [])[0] || {}).join(', ')}`);
    console.log(`Fotoğraf bulunan ürün: ${products.filter((p) => imagesOf(p).length).length}`);
    console.log(`Fiyat okunan ürün: ${products.filter((p) => priceOf(p)).length}`);
    const vis = products.filter((p) => !isHidden(p));
    console.log(`placementScore türleri: ${[...new Set(vis.map((p) => typeof p.placementScore))].join(',')} | farklı değer: ${new Set(vis.map((p) => p.placementScore)).size}`);
    console.log(`API sırası (ilk 25): ${vis.slice(0, 25).map((p) => p.id).join(' ')}`);
    console.log(`placementScore büyükten küçüğe (ilk 25): ${[...vis].sort((a, b) => Number(b.placementScore) - Number(a.placementScore)).slice(0, 25).map((p) => `${p.id}:${p.placementScore}`).join(' ')}`);
    console.log(`placementScore küçükten büyüğe (ilk 25): ${[...vis].sort((a, b) => Number(a.placementScore) - Number(b.placementScore)).slice(0, 25).map((p) => `${p.id}:${p.placementScore}`).join(' ')}`);
    process.exit(0);
}

const productsFile = join(ROOT, 'products.json');
const urlsFile = join(ROOT, 'shopier-urls.json');
const existing = JSON.parse(readFileSync(productsFile, 'utf8'));
const known = JSON.parse(readFileSync(urlsFile, 'utf8'));
const prevByUrl = new Map(existing.map((p) => [p.url, p]));
const idByUrl = new Map(known.map((k) => [k.url, Number(k.id)]));
let nextId = Math.max(0, ...existing.map((p) => Number(p.id) || 0), ...known.map((k) => Number(k.id) || 0)) + 1;

const live = products.filter((p) => !isHidden(p));
const out = [];
for (const p of live) {
    const url = shopierUrl(p);
    const prev = prevByUrl.get(url) || {};
    if (!idByUrl.has(url)) idByUrl.set(url, nextId++);
    const id = idByUrl.get(url);
    const liveTitle = clean(p.title) || prev.title || `Urun ${id}`;
    const prevSize = (prev.title || '').match(/\([^)]+\)\s*$/);
    const title = prevSize && !/\([^)]+\)\s*$/.test(liveTitle) ? `${liveTitle} ${prevSize[0].trim()}` : liveTitle;
    const images = imagesOf(p);
    const sizeStock = sizeStockOf(p);
    const stock = stockOf(p, sizeStock);
    const fromShopier = shopierCategories(p);
    const category = getCategory(title, prev.category, fromShopier);
    out.push({
        id,
        title,
        price: priceOf(p) || prev.price || '',
        image: images[0] || prev.image || '',
        images: images.length ? images : (prev.images || (prev.image ? [prev.image] : [])),
        filename: prev.filename || `${id}.jpeg`,
        url,
        category,
        categories: getCategories(title, category, [...(prev.categories || []), ...fromShopier]),
        ...(stock !== undefined ? { stock } : prev.stock !== undefined ? { stock: prev.stock } : {}),
        ...(sizeStock ? { sizeStock } : prev.sizeStock ? { sizeStock: prev.sizeStock } : {})
    });
}

// Sıralama: mevcut ürünler eski sıralarını korur, yeni ürünler en başa gelir.
const prevIndex = new Map(existing.map((p, i) => [p.url, i]));
out.sort((a, b) => (prevIndex.has(a.url) ? prevIndex.get(a.url) : -1) - (prevIndex.has(b.url) ? prevIndex.get(b.url) : -1));

// Güvenlik: API beklenenden çok az ürün döndürürse kataloğu silmemek için dur.
if (out.length < Math.floor(existing.length * 0.6)) {
    console.error(`API ${out.length} ürün döndürdü (mevcut ${existing.length}); katalog güncellenmedi.`);
    process.exit(1);
}

writeFileSync(productsFile, `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(urlsFile, `${JSON.stringify(out.map(({ id, url }) => ({ id, url })), null, 2)}\n`);
const added = out.filter((p) => !prevByUrl.has(p.url)).length;
const removed = existing.filter((p) => !out.some((o) => o.url === p.url)).length;
console.log(`Bitti. Ürün: ${out.length} (yeni: ${added}, satıştan kalkan: ${removed})`);
