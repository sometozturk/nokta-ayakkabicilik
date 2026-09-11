const fs = require('fs');
const path = require('path');

const editsFile = process.argv[2] || 'products_edited.json';
const outJson = 'products.json';
const outCsv = 'products.csv';

function toCSV(arr){
  const header = ['id','filename','title','price','url'];
  const lines = [header.join(',')];
  for(const p of arr){
    const row = [p.id||'', p.filename||'', `"${(p.title||'').replace(/"/g,'""')}"`, p.price||'', p.url||''];
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

if(!fs.existsSync(editsFile)){
  console.error(`Dosya bulunamadı: ${editsFile}. Lütfen düzenlenmiş JSON dosyasını (ör. products_edited.json) workspace'e koyun veya dosya adını argüman olarak verin.`);
  process.exit(1);
}

let data;
try{
  data = JSON.parse(fs.readFileSync(editsFile, 'utf8'));
  if(!Array.isArray(data)) throw new Error('JSON dizi değil');
}catch(e){
  console.error('JSON okunamadı veya geçersiz:', e.message);
  process.exit(1);
}

// Normalize: ensure ids are numbers and sorted by id
data = data.map(p=>({ id: Number(p.id)||null, filename: p.filename||null, title: p.title||'', price: p.price||'', url: p.url||'' }));
data.sort((a,b)=> (a.id||0)-(b.id||0));

fs.writeFileSync(outJson, JSON.stringify(data, null, 2), 'utf8');
fs.writeFileSync(outCsv, toCSV(data), 'utf8');

console.log(`Başarılı: ${outJson} ve ${outCsv} oluşturuldu/üstüne yazıldı (${data.length} kayıt).`);
