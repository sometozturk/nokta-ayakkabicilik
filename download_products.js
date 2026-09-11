const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const outDir = path.resolve(__dirname);

async function fetchHtml(url){
  const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  return r.data;
}

(async ()=>{
  const shopUrl = 'https://shopier.com/noktaayakkabi';
  console.log('Crawling shop pages for product links (pagination included)...');

  // Breadth-first crawl of shop pages following pagination links
  const pagesToVisit = [shopUrl];
  const visitedPages = new Set();
  const productLinks = new Set();

  while(pagesToVisit.length){
    const page = pagesToVisit.shift();
    if(visitedPages.has(page)) continue;
    visitedPages.add(page);
    try{
      console.log('Fetching shop page:', page);
      const html = await fetchHtml(page);
      const $ = cheerio.load(html);

      // collect product links on this shop page
      $('a').each((i, el)=>{
        const href = $(el).attr('href');
        if(!href) return;
        let abs = href;
        try{ abs = new URL(href, shopUrl).href; }catch(e){}
        if(/\/noktaayakkabi\/\d+/.test(abs)) productLinks.add(abs);
      });

      // find pagination links (rel="next" or ?page= / page/ patterns)
      $('a').each((i, el)=>{
        const href = $(el).attr('href');
        if(!href) return;
        const text = $(el).text().trim();
        if(/rel=("|')?next("|')?/i.test($(el).attr('rel') || '')){
          try{ pagesToVisit.push(new URL(href, shopUrl).href); }catch(e){}
        } else if (/page=\d+|page\/\d+|\?p=\d+/i.test(href) || /sonraki|next|>/i.test(text)){
          try{ pagesToVisit.push(new URL(href, shopUrl).href); }catch(e){}
        }
      });

    }catch(err){
      console.error('Failed to fetch shop page', page, err.message);
    }
  }

  const urls = Array.from(productLinks).filter(u=>/\/noktaayakkabi\/\d+/.test(u));
  console.log('Found', urls.length, 'product links across pages');

  const products = [];
  let idx = 1;
  for(const url of urls){
    try{
      console.log('Fetching', url);
      const html = await fetchHtml(url);
      const $$ = cheerio.load(html);
      const title = $$('meta[property="og:title"]').attr('content') || $$('title').text().trim();
      let image = $$('meta[property="og:image"]').attr('content') || $$('img').first().attr('src') || '';
      if(image && image.startsWith('//')) image = 'https:' + image;
      let price = $$('meta[itemprop="price"]').attr('content') || $$('meta[property="product:price:amount"]').attr('content') || '';
      if(!price){
        const text = $$.text();
        const m = text.match(/\d[\d\.\,\s]*TL/);
        price = m ? m[0].trim() : '';
      }

      let filename = null;
      if(image){
        try{
          const urlObj = new URL(image);
          const ext = path.extname(urlObj.pathname) || '.jpeg';
          filename = `${idx}${ext}`;
          const imgRes = await axios.get(image, { responseType: 'arraybuffer' });
          fs.writeFileSync(path.join(outDir, filename), imgRes.data);
          console.log('Saved', filename);
        }catch(err){
          console.error('Image download failed for', image, err.message);
        }
      }

      products.push({ id: idx, title, price, image, filename, url });
      idx++;
    }catch(e){
      console.error('Failed', url, e.message);
    }
  }

  fs.writeFileSync(path.join(outDir, 'products.json'), JSON.stringify(products, null, 2));
  const csv = ['id,filename,title,price,url', ...products.map(p=>`${p.id},${p.filename || ''},"${(p.title||'').replace(/"/g,'""')}","${(p.price||'')}" ,${p.url}`)];
  fs.writeFileSync(path.join(outDir, 'products.csv'), csv.join('\n'));
  console.log('Done. Products:', products.length);
})().catch(e=>{ console.error(e); process.exit(1); });
