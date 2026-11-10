// Sepet kapak fotoğrafı: hazır ham RGB parçaları (assets/tiles/<id>.bin, gzip) yan yana dizip PNG üretir.
// Fotoğraf çözme/sıkıştırma yapılmaz (PNG "stored" blokları), böylece Worker CPU sınırına takılmaz.
export const TILE = 300;
export const SIZE = 600;          // kapak 600x600
const GAP = 8;
const WHITE = 255;

/** Ürün sayısına göre her parçanın yeri ve ölçeği. */
export function layout(n) {
  if (n <= 1) return [{ x: (SIZE - TILE) / 2, y: (SIZE - TILE) / 2, s: TILE }];
  if (n === 2) {
    const s = (SIZE - GAP) / 2;                       // 296
    return [0, 1].map(i => ({ x: i * (s + GAP), y: (SIZE - s) / 2, s }));
  }
  if (n <= 4) {
    const s = (SIZE - GAP) / 2;
    const cells = [0, 1, 2, 3].map(i => ({ x: (i % 2) * (s + GAP), y: Math.floor(i / 2) * (s + GAP), s }));
    if (n === 3) cells[2].x = (SIZE - s) / 2;          // tek kalanı ortala
    return cells.slice(0, n);
  }
  const s = Math.floor((SIZE - 2 * GAP) / 3);          // 194
  const cells = [];
  for (let i = 0; i < Math.min(n, 9); i++) cells.push({ x: (i % 3) * (s + GAP), y: Math.floor(i / 3) * (s + GAP), s });
  return cells;
}

/** Parçaları tuvale yerleştirir (gerekirse en yakın komşu ile küçültür). tiles: Uint8Array (TILE*TILE*3) */
export function compose(tiles) {
  const img = new Uint8Array(SIZE * SIZE * 3).fill(WHITE);
  const cells = layout(tiles.length);
  tiles.slice(0, cells.length).forEach((tile, i) => {
    const { x, y, s } = cells[i];
    const ox = Math.round(x), oy = Math.round(y), size = Math.round(s);
    if (size === TILE) {
      for (let r = 0; r < TILE; r++) img.set(tile.subarray(r * TILE * 3, (r + 1) * TILE * 3), ((oy + r) * SIZE + ox) * 3);
      return;
    }
    for (let r = 0; r < size; r++) {
      const sr = Math.min(TILE - 1, Math.floor((r + 0.5) * TILE / size));
      let d = ((oy + r) * SIZE + ox) * 3;
      for (let c = 0; c < size; c++) {
        const sc = Math.min(TILE - 1, Math.floor((c + 0.5) * TILE / size)) ;
        const si = (sr * TILE + sc) * 3;
        img[d++] = tile[si]; img[d++] = tile[si + 1]; img[d++] = tile[si + 2];
      }
    }
  });
  return img;
}

let CRC_TABLE;
function crc32(bytes, crc = 0xffffffff) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

/** RGB pikselleri sıkıştırmasız (stored deflate) PNG'ye çevirir. */
export function encodePNG(rgb, w = SIZE, h = SIZE) {
  const rowLen = w * 3 + 1;
  const raw = new Uint8Array(rowLen * h);
  for (let y = 0; y < h; y++) { raw[y * rowLen] = 0; raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * rowLen + 1); }
  // zlib: başlık + stored bloklar + adler32
  const BLOCK = 65535, blocks = Math.ceil(raw.length / BLOCK);
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78; z[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const start = b * BLOCK, len = Math.min(BLOCK, raw.length - start);
    z[o++] = b === blocks - 1 ? 1 : 0;
    z[o++] = len & 0xff; z[o++] = len >>> 8; z[o++] = ~len & 0xff; z[o++] = (~len >>> 8) & 0xff;
    z.set(raw.subarray(start, start + len), o); o += len;
  }
  let a = 1, bsum = 0;
  for (let i = 0; i < raw.length; ) {
    const end = Math.min(raw.length, i + 5552);
    for (; i < end; i++) { a += raw[i]; bsum += a; }
    a %= 65521; bsum %= 65521;
  }
  z[o++] = bsum >>> 8; z[o++] = bsum & 0xff; z[o++] = a >>> 8; z[o++] = a & 0xff;

  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
    return out;
  };
  const ihdr = new Uint8Array(13); const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w); iv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const png = new Uint8Array(total); let p = 0;
  for (const part of parts) { png.set(part, p); p += part.length; }
  return png;
}

/** gzip'li parçayı açar. */
export async function gunzip(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
