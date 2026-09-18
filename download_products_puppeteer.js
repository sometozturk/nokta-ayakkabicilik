const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const outDir = path.resolve(__dirname);

async function downloadBuffer(url){
  const res = await axios.get(url, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' } });
  return res.data;
}

async function crawlShopPages(browser, shopUrl){
  const page = await browser.newPage();
  const visited = new Set();
  const toVisit = [shopUrl];
  const productLinks = new Set();

  while(toVisit.length){
    const url = toVisit.shift();
    if(visited.has(url)) continue;
    visited.add(url);
    try{
      console.log('Open', url);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForTimeout(500);

      const anchors = await page.$$eval('a', els => els.map(a=>({href: a.href, text: a.textContent || '', rel: a.rel || '' })));
      for(const a of anchors){
        if(!a.href) continue;
        if(/\/noktaayakkabi\/\d+/.test(a.href)) productLinks.add(a.href.split('#')[0]);
        // detect pagination
        if(/rel=(?:"|')?next(?:"|')?/i.test(a.rel)){
          toVisit.push(a.href);
        } else if(/page=\d+|page\/\d+|\?p=\d+/i.test(a.href) || /sonraki|next|>/i.test(a.text)){
          toVisit.push(a.href);
        }
      }
    }catch(e){
      console.error('Page open failed', url, e.message);
    }
  }
  await page.close();
  return Array.from(productLinks);
}

async function extractProduct(page, url){
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(300);
  const data = await page.evaluate(()=>{
    const getMeta = (name) => document.querySelector(`meta[property="${name}"]`)?.content || document.querySelector(`meta[name="${name}"]`)?.content || '';
    const title = getMeta('og:title') || document.title || '';
    const images = Array.from(document.querySelectorAll('meta[property="og:image"], img[src], img[data-src], img[data-lazy-src]'))
      .map(element => element.content || element.src || element.dataset.src || element.dataset.lazySrc || '')
      .filter(image => /\/pictures_(large|small)\//i.test(image))
      .filter((image, index, all) => image && all.indexOf(image) === index);
    const largeImages = images.filter(image => /\/pictures_large\//i.test(image));
    const selectedImages = largeImages.length ? largeImages : images;
    const image = selectedImages[0] || '';
    let price = '';
    const p1 = document.querySelector('[itemprop="price"]');
    if(p1) price = p1.getAttribute('content') || p1.textContent || '';
    if(!price){
      const priceEl = Array.from(document.querySelectorAll('*')).find(n=>/\d+\s*TL/i.test(n.textContent || ''));
      if(priceEl) price = (priceEl.textContent.match(/\d[\d\.\,\s]*TL/i)||[''])[0];
    }
    return { title, image, images: selectedImages, price };
  });
  return data;
}

(async ()=>{
  const shopUrl = 'https://shopier.com/noktaayakkabi';
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try{
    const productUrls = await crawlShopPages(browser, shopUrl);
    console.log('Product URLs found:', productUrls.length);

    const page = await browser.newPage();
    const products = [];
    let idx = 1;
    for(const url of productUrls){
      try{
        console.log('Extracting', url);
        const p = await extractProduct(page, url);
        let filename = null;
        if(p.image){
          try{
            const u = new URL(p.image);
            const ext = path.extname(u.pathname) || '.jpeg';
            filename = `${idx}${ext}`;
            const buf = await downloadBuffer(p.image);
            fs.writeFileSync(path.join(outDir, filename), buf);
            console.log('Saved', filename);
          }catch(err){
            console.error('Image save failed', err.message);
          }
        }
        products.push({ id: idx, title: p.title, price: p.price, image: p.image, images: p.images, filename, url });
        idx++;
      }catch(e){ console.error('Failed product', url, e.message); }
    }
    fs.writeFileSync(path.join(outDir, 'products_puppeteer.json'), JSON.stringify(products, null, 2));
    console.log('Done. Total products:', products.length);
    await page.close();
  }finally{
    await browser.close();
  }
})().catch(e=>{ console.error(e); process.exit(1); });
