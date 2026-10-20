#!/usr/bin/env node
/*
 * IndexNow bildirimi (Bing, Yandex, Seznam, Naver). Google IndexNow kullanmaz.
 * Son commit'te değişen sayfaları bulur ve tek istekle bildirir. Değişen sayfa yoksa bir şey yapmaz.
 * Kullanım: node scripts/indexnow.mjs [karşılaştırılacak-commit=HEAD~1]
 * Anahtar dosyası: /a40a65263276459d30037ab9231677c8.txt (sitenin kökünde yayında olmalı)
 */
import { execFileSync } from 'node:child_process';

const HOST = 'www.noktaayakkabicilik.com';
const KEY = 'a40a65263276459d30037ab9231677c8';
const base = process.argv[2] || 'HEAD~1';

let changed;
try {
    changed = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
    console.log('IndexNow: önceki commit bulunamadı, bildirim atlandı.');
    process.exit(0);
}

const urls = new Set();
for (const file of changed) {
    if (file === 'index.html') urls.add('/');
    else if (/^(katalog|bilgilendirme)\.html$/.test(file)) urls.add('/' + file);
    else if (/^(kategori|urun)\/[^/]+\/index\.html$/.test(file)) urls.add('/' + file.replace(/index\.html$/, ''));
}
if (!urls.size) {
    console.log('IndexNow: değişen sayfa yok.');
    process.exit(0);
}

const urlList = [...urls].map((path) => `https://${HOST}${path}`);
const response = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList })
});
console.log(`IndexNow: ${urlList.length} URL bildirildi, yanıt ${response.status}`);
urlList.forEach((url) => console.log('  ' + url));
