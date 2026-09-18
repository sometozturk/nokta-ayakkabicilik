const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const fs = require('fs');

const shopUrl = 'https://www.shopier.com/noktaayakkabi';
const urlsFile = 'shopier-urls.json';
const productsFile = 'products.json';
const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; NoktaAyakkabicilikSync/1.0)' };

async function fetchHtml(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return page.content();
}

function absoluteUrl(value) {
  if (!value) return '';
  try {
    return new URL(value, shopUrl).href;
  } catch {
    return '';
  }
}

function extractImages($) {
  const images = [];
  $('meta[property="og:image"], img[src], img[data-src], img[data-lazy-src]').each((_, element) => {
    const value = $(element).attr('content') || $(element).attr('src') || $(element).attr('data-src') || $(element).attr('data-lazy-src');
    const image = absoluteUrl(value);
    if (image && /\/pictures_(large|small)\//i.test(image) && !images.includes(image)) images.push(image);
  });
  const largeImages = images.filter(image => /\/pictures_large\//i.test(image));
  return largeImages.length ? largeImages : images;
}

function extractProduct(html, url) {
  const $ = cheerio.load(html);
  const title = $('meta[property="og:title"]').attr('content') || $('title').text().trim();
  if (/just a moment|enable javascript and cookies|challenge-platform/i.test($.text()) || /just a moment/i.test(title)) {
    throw new Error('Shopier Cloudflare challenge page received');
  }
  const images = extractImages($);
  const image = images[0] || '';

  let price = $('meta[itemprop="price"]').attr('content') || $('meta[property="product:price:amount"]').attr('content') || '';
  if (!price) {
    const match = $.text().match(/\d[\d.\s,]*TL/i);
    price = match ? match[0].replace(/TL/i, '').replace(/[.\s]/g, '').replace(',', '.').trim() : '';
  }

  return { title: title.trim(), price: price.trim(), image, images, url };
}

async function discoverUrls(page) {
  const html = await fetchHtml(page, shopUrl);
  const $ = cheerio.load(html);
  return $('a[href]')
    .map((_, element) => absoluteUrl($(element).attr('href')))
    .get()
    .filter((url) => /\/noktaayakkabi\/\d+$/.test(url));
}

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36');
  const known = JSON.parse(fs.readFileSync(urlsFile, 'utf8'));
  const existing = fs.existsSync(productsFile) ? JSON.parse(fs.readFileSync(productsFile, 'utf8')) : [];
  const byUrl = new Map(known.map((item) => [item.url, item]));
  const discovered = await discoverUrls(page);
  let nextId = Math.max(0, ...existing.map((product) => Number(product.id) || 0), ...known.map((item) => Number(item.id) || 0)) + 1;

  for (const url of discovered) {
    if (!byUrl.has(url)) {
      byUrl.set(url, { id: nextId++, url });
    }
  }

  const products = [];
  for (const item of byUrl.values()) {
    const previous = existing.find((product) => product.url === item.url) || {};
    try {
      const live = extractProduct(await fetchHtml(page, item.url), item.url);
      products.push({
        id: Number(item.id),
        title: live.title || previous.title || `Urun ${item.id}`,
        price: live.price || previous.price || '',
        image: live.image || previous.image || '',
        images: live.images?.length ? live.images : (previous.images || (previous.image ? [previous.image] : [])),
        filename: previous.filename || `${item.id}.jpeg`,
        url: item.url
      });
      console.log(`Synced ${item.id}: ${live.title} - ${live.price}`);
    } catch (error) {
      console.warn(`Could not sync ${item.url}: ${error.message}`);
      if (Object.keys(previous).length) products.push(previous);
    }
  }

  products.sort((a, b) => a.id - b.id);
  const syncedUrls = products.map(({ id, url }) => ({ id, url }));
  fs.writeFileSync(productsFile, `${JSON.stringify(products, null, 2)}\n`);
  fs.writeFileSync(urlsFile, `${JSON.stringify(syncedUrls, null, 2)}\n`);
  console.log(`Done. Products: ${products.length}`);
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
