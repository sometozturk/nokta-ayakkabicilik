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

function extractProduct(html, url) {
  const $ = cheerio.load(html);
  const title = $('meta[property="og:title"]').attr('content') || $('title').text().trim();
  let image = $('meta[property="og:image"]').attr('content') || '';
  if (image.startsWith('//')) image = `https:${image}`;

  let price = $('meta[itemprop="price"]').attr('content') || $('meta[property="product:price:amount"]').attr('content') || '';
  if (!price) {
    const match = $.text().match(/\d[\d.\s,]*TL/i);
    price = match ? match[0].replace(/TL/i, '').replace(/[.\s]/g, '').replace(',', '.').trim() : '';
  }

  return { title: title.trim(), price: price.trim(), image, url };
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
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
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
