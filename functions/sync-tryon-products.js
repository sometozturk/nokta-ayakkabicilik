const fs = require('node:fs');
const path = require('node:path');

const sourceProducts = require('../products.json');
const products = sourceProducts.map(({id, title, image}) => ({id, title, image}));

if (products.some(product => !product.id || !product.title || !product.image || new URL(product.image).hostname !== 'cdn.shopier.app')) {
  throw new Error('Try-on catalog contains an invalid product or image host.');
}

fs.writeFileSync(path.join(__dirname, 'tryon-products.json'), `${JSON.stringify(products, null, 2)}\n`);