#!/usr/bin/env node
/*
 * Nokta Ayakkabıcılık – SEO sayfa üreticisi
 *
 * products.json'dan Google'ın okuyabileceği statik sayfalar üretir:
 *   /kategori/<slug>/   kategori ve koleksiyon sayfaları (ItemList + Breadcrumb + FAQ schema)
 *   /urun/<slug>/       ürün sayfaları (Product + Offer + Breadcrumb schema)
 *   /sitemap.xml        tüm sayfalar + ürün görselleri (image sitemap)
 *
 * Bağımlılık yok (Node 18+). Yerelde: npm run build:seo
 * Çıktı (kategori/, urun/, sitemap.xml) depoya commit edilir; Shopier senkronu ve yayın işi
 * her çalıştırmada sıfırdan yeniden üretir. Bu klasörleri elle düzenlemeyin, betiği değiştirin.
 * Çıktı deterministiktir (tarih içermez), ürünler değişmedikçe commit oluşmaz.
 *
 * Not: Başlığında üçüncü taraf marka adı geçen ürünler (Nike, Adidas, Prada vb.) için ayrı
 * SEO sayfası üretilmez. Bu ürünler ana sayfadaki katalogda görünmeye devam eder.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] ? resolve(process.argv[2]) : ROOT;
const SITE = 'https://www.noktaayakkabicilik.com';
const BUILD_DATE = new Date().toISOString().slice(0, 10);
const PIXEL_ID = '1623153919352122';

const INSTAGRAM = 'https://www.instagram.com/nokta.ayakkabicilik/';
const INSTAGRAM_SHIC = 'https://www.instagram.com/noktashic/';
const SHOPIER = 'https://www.shopier.com/noktaayakkabi';

// Başlıkta geçtiğinde ürünün SEO sayfası üretilmeyen üçüncü taraf marka ve model adları.
const THIRD_PARTY_BRANDS = /\b(nike|adidas|vans|lacoste|lufian|calvin|klein|mc ?queen|golden ?goose|prada|ugg|cat|caterpillar|harley|davidson|jordan|air ?force|airforce|air ?max|air270|dunk|samba|spezial|campus|s[uü]perstar|terrex|duramo|entrap|xstep|converse|puma|new ?balance|skechers|timberland|martens|balenciaga|gucci|vuitton|dior|chanel|herm[eè]s|asics|reebok|fila|hummel|kinetix|polaris|lumberjack|polo|tommy|hilfiger|guess|michael ?kors|steve ?madden|zara|bershka|mango|tn|p6000|initiator|court ?borough|zoom|cherry|travis)\b/i;

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------
const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const lower = (value) => String(value || '').toLocaleLowerCase('tr-TR');

const slugify = (value) => lower(value)
    .replace(/[çÇ]/g, 'c').replace(/[ğĞ]/g, 'g').replace(/[ıİ]/g, 'i').replace(/[öÖ]/g, 'o')
    .replace(/[şŞ]/g, 's').replace(/[üÜ]/g, 'u').replace(/[âàá]/g, 'a').replace(/[îíì]/g, 'i').replace(/[ûúù]/g, 'u')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');

const formatPrice = (value) => `${Number(value).toLocaleString('tr-TR')} TL`;

// Türkçe ilk harf büyütme ("kısa topuk" -> "Kısa topuk")
const capFirst = (value) => value ? value.charAt(0).toLocaleUpperCase('tr-TR') + value.slice(1) : value;

const jsonLd = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

const shopierId = (url) => String(url || '').split('?')[0].replace(/\/$/, '').split('/').pop();

const truncate = (text, max) => {
    if (text.length <= max) return text;
    const cut = text.slice(0, max - 1);
    return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
};

// ---------------------------------------------------------------------------
// Ürünleri hazırla
// ---------------------------------------------------------------------------
const raw = JSON.parse(readFileSync(join(ROOT, 'products.json'), 'utf8'));

const products = raw
    .filter((p) => p && p.title && p.url && Number(p.price) > 0)
    .map((p) => {
        const title = String(p.title).replace(/\s+/g, ' ').trim();
        const sizeMatch = title.match(/\(([\d\s\-–/]+)\)\s*$/) || title.match(/\(([\d\s\-–/]+)\)/);
        const sizes = sizeMatch ? sizeMatch[1].replace(/\s+/g, '').replace(/–/g, '-') : '';
        const name = title.replace(/\s*\([\d\s\-–/]+\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
        const images = [...new Set([...(p.images || []), p.image].filter((src) => /^https:\/\//.test(src || '')))];
        return {
            id: Number(p.id),
            title,
            name,
            sizes,
            price: Number(p.price),
            images,
            shopierUrl: p.url,
            shopierId: shopierId(p.url),
            category: p.category || '',
            generic: !THIRD_PARTY_BRANDS.test(title),
            slug: `${slugify(name)}-${p.id}`,
            t: lower(name)
        };
    })
    .filter((p) => p.images.length);

const isHeel = (p) => p.category === 'Topuklu Nokta Shic';
const isWomenBoot = (p) => p.category === 'Kadın Bot';
const isMen = (p) => p.category === 'Erkek Bot' || /oxford|erkek|unisex/.test(p.t);
const isKids = (p) => p.category === 'Çocuk Sneakers' || /çocuk/.test(p.t);

// ---------------------------------------------------------------------------
// Kategori ve koleksiyon tanımları
// ---------------------------------------------------------------------------
const SHIPPING_FAQ = {
    q: 'Siparişim ne zaman kargoya verilir?',
    a: 'Saat 17:00\'ye kadar verilen siparişler aynı gün kargoya teslim edilir. 17:00\'den sonraki siparişler genellikle ertesi gün kargoya verilir.'
};
const EXCHANGE_FAQ = {
    q: 'Numara uymazsa değişim yapabilir miyim?',
    a: 'Evet. Nokta Ayakkabıcılık iade ve değişim garantisi sunar; talebinizi sipariş bilgilerinizle Instagram üzerinden iletmeniz yeterlidir.'
};
const PAYMENT_FAQ = {
    q: 'Ödeme nasıl yapılır, güvenli mi?',
    a: 'Siparişler Shopier üzerinden verilir. Kart bilgileriniz Shopier\'in güvenli ödeme altyapısında işlenir, bu siteye iletilmez.'
};

const CATEGORIES = [
    {
        slug: 'kadin-topuklu-ayakkabi',
        name: 'Kadın Topuklu Ayakkabı',
        nav: 'Topuklu',
        h1: 'Kadın Topuklu Ayakkabı Modelleri',
        title: 'Kadın Topuklu Ayakkabı Modelleri ve Fiyatları | Nokta Shic',
        description: ({ min }) => `Kadeh, kısa, ince ve önü açık topuklu ayakkabı modelleri ${min}'den başlayan fiyatlarla. 17:00'ye kadar siparişte aynı gün kargo, iade ve değişim garantisi.`,
        intro: ({ count }) => `Nokta Shic topuklu ayakkabı koleksiyonu; ofis, günlük kullanım ve davetler için ${count} modeli tek sayfada topluyor. Topuk tipine göre aşağıdaki koleksiyonlara da göz atabilirsiniz.`,
        audience: 'female',
        brand: 'Nokta Shic',
        match: (p) => p.generic && isHeel(p),
        guide: [
            ['Topuk tipine göre seçim', [
                '<strong>Kadeh topuk</strong> üstte geniş başlayıp aşağı doğru incelir; ince topuk kadar şık görünür ama zeminde daha dengeli durur. Ofisten akşam davetine geçilen günler için iyi bir başlangıçtır.',
                '<strong>Kısa topuk</strong>, ayağın ön kısmına binen yükü yüksek topuklara göre azaltır. Gün boyu ayakta kalınan iş günlerinde ve günlük kombinlerde öne çıkar.',
                '<strong>Önü açık</strong> modeller bahar, yaz ve davet sezonunun klasiğidir. Bej ve ten tonları bacak hattını uzun gösterir; gümüş ve gold detaylı modeller abiye kombinleri tamamlar.'
            ]],
            ['Numara seçerken', [
                'Topuklu ayakkabıda ayak öne doğru kaydığı için iki numara arasında kalıyorsanız genellikle büyük numara daha rahat eder. Emin değilseniz model adını Instagram\'dan yazarak bize sorabilirsiniz.'
            ]]
        ],
        faq: [SHIPPING_FAQ, EXCHANGE_FAQ, PAYMENT_FAQ]
    },
    {
        slug: 'kadeh-topuk-ayakkabi',
        parent: 'kadin-topuklu-ayakkabi',
        name: 'Kadeh Topuk Ayakkabı',
        h1: 'Kadeh Topuk Ayakkabı Modelleri',
        title: 'Kadeh Topuk Ayakkabı Modelleri ve Fiyatları | Nokta Shic',
        description: ({ min }) => `Kadeh topuk ayakkabı modelleri ${min}'den başlayan fiyatlarla Nokta Shic'te. 17:00'ye kadar siparişte aynı gün kargo, iade ve değişim garantisi.`,
        intro: ({ count }) => `Kadeh topuk, adını şarap kadehini andıran inceltilmiş formundan alır: ince topuk kadar şık, ondan daha dengeli. Koleksiyondaki ${count} kadeh topuk modelini aşağıda inceleyebilirsiniz.`,
        audience: 'female',
        brand: 'Nokta Shic',
        match: (p) => p.generic && isHeel(p) && /kadeh/.test(p.t),
        guide: [
            ['Kadeh topuk kimler için uygun?', [
                'Yüksek topuğa yeni alışanlar ve aynı gün içinde hem ofiste hem akşam davetinde aynı ayakkabıyı giymek isteyenler için kadeh topuk dengeli bir tercihtir. Kısa ve orta kadeh topuklar günlük kullanımda, kurdeleli ve gümüş detaylı modeller davetlerde öne çıkar.'
            ]],
            ['Renk seçimi', [
                'Siyah kadeh topuk ayakkabı ofis ve gece kombinlerine kolayca uyar. Bej ve ten tonları bacak hattını uzatır; gümüş ve beyaz modeller ise abiye ve beyaz elbise altında tercih edilir.'
            ]]
        ],
        faq: [
            { q: 'Kadeh topuk ile ince topuk arasındaki fark nedir?', a: 'İnce (stiletto) topuk boydan boya incedir. Kadeh topuk ise üstte geniş başlayıp aşağıda incelir, bu yüzden zeminde daha dengeli durur.' },
            SHIPPING_FAQ,
            EXCHANGE_FAQ
        ]
    },
    {
        slug: 'onu-acik-topuklu-ayakkabi',
        parent: 'kadin-topuklu-ayakkabi',
        name: 'Önü Açık Topuklu Ayakkabı',
        h1: 'Önü Açık Topuklu Ayakkabı Modelleri',
        title: 'Önü Açık Topuklu Ayakkabı Modelleri | Nokta Shic',
        description: ({ min }) => `Kısa ve uzun topuklu, önü açık kadın ayakkabı modelleri ${min}'den başlayan fiyatlarla. Aynı gün kargo, iade ve değişim garantisi.`,
        intro: ({ count }) => `Burnu açık kesimiyle ayağı hafif gösteren önü açık topuklu ayakkabılar bahar, yaz ve davet sezonunun klasiği. Kısa ve uzun topuklu ${count} modeli inceleyin.`,
        audience: 'female',
        brand: 'Nokta Shic',
        match: (p) => p.generic && isHeel(p) && /önü açık/.test(p.t),
        guide: [
            ['Önü açık topuklu ayakkabı nasıl kombinlenir?', [
                'Beyaz ve bej modeller elbise ve etekle, siyah modeller kumaş pantolon ve takımlarla kolayca eşleşir. Kısa topuklu önü açık modeller gün boyu, uzun topuklular ise akşam davetlerinde öne çıkar.'
            ]]
        ],
        faq: [
            { q: 'Önü açık topuklu ayakkabı kışın giyilir mi?', a: 'Kapalı mekân davetlerinde ve ince çorapla kış aylarında da kullanılabilir. Günlük kış kullanımı için kapalı burunlu modeller veya botlar daha uygundur.' },
            SHIPPING_FAQ,
            EXCHANGE_FAQ
        ]
    },
    {
        slug: 'kisa-topuklu-ayakkabi',
        parent: 'kadin-topuklu-ayakkabi',
        name: 'Kısa Topuklu Ayakkabı',
        h1: 'Kısa Topuklu Ayakkabı Modelleri',
        title: 'Kısa Topuklu Ayakkabı Modelleri ve Fiyatları | Nokta Shic',
        description: ({ min }) => `Ofis ve günlük kullanım için kısa topuklu kadın ayakkabı modelleri ${min}'den başlayan fiyatlarla. Aynı gün kargo, iade ve değişim garantisi.`,
        intro: ({ count, min }) => `Topuklu ayakkabının şıklığını gün boyu taşınabilir bir yükseklikle sunan kısa topuklu modeller ofis, okul ve günlük kombinler için ideal. ${count} model, ${min}'den başlayan fiyatlarla.`,
        audience: 'female',
        brand: 'Nokta Shic',
        match: (p) => p.generic && isHeel(p) && /kısa topuk/.test(p.t),
        guide: [
            ['Neden kısa topuk?', [
                'Kısa topuk, ayağın ön kısmına binen yükü yüksek topuklulara göre azaltır; bu yüzden uzun süre ayakta kalınan günlerde tercih edilir. Küt burunlu modeller parmaklara daha geniş alan bırakır, gold ve gümüş detaylı modeller ise sade kombinlere hareket katar.'
            ]]
        ],
        faq: [
            { q: 'Kısa topuklu ayakkabı ofiste giyilir mi?', a: 'Evet. Siyah, bej ve rugan kısa topuklu modeller kumaş pantolon, etek ve takımlarla ofiste rahatça kullanılır.' },
            SHIPPING_FAQ,
            EXCHANGE_FAQ
        ]
    },
    {
        slug: 'abiye-topuklu-ayakkabi',
        parent: 'kadin-topuklu-ayakkabi',
        name: 'Abiye Topuklu Ayakkabı',
        h1: 'Abiye Topuklu Ayakkabı Modelleri',
        title: 'Abiye Ayakkabı: Simli ve Taşlı Topuklu Modeller | Nokta',
        description: ({ min }) => `Düğün, nişan ve davetler için simli, taşlı ve kurdeleli abiye topuklu ayakkabılar ${min}'den başlayan fiyatlarla. Aynı gün kargo, iade ve değişim garantisi.`,
        intro: ({ count }) => `Düğün, nişan, mezuniyet ve davetler için simli, taşlı, kurdeleli ve şeffaf detaylı ${count} abiye topuklu ayakkabı modeli tek sayfada.`,
        audience: 'female',
        brand: 'Nokta Shic',
        match: (p) => p.generic && isHeel(p) && /simli|taşlı|kurdeleli|şeffaf/.test(p.t),
        guide: [
            ['Abiye ayakkabı seçerken', [
                'Elbisenizdeki taş veya işleme rengini ayakkabıda tekrarlamak kombini toparlar: gümüş detaylı elbiseye gümüş simli, altın tonlu elbiseye gold modeller iyi eşleşir. Gece boyu ayakta kalacaksanız kadeh veya kısa topuklu abiye modeller daha az yorar.'
            ]]
        ],
        faq: [
            { q: 'Düğün için hangi topuklu ayakkabı seçilmeli?', a: 'Gece boyunca ayakta kalacaksanız kadeh ya da kısa topuklu, simli veya taşlı bir model hem şık hem dengeli bir tercihtir.' },
            { q: 'Davetim yaklaşıyor, sipariş ne zaman elimde olur?', a: '17:00\'ye kadar verilen siparişler aynı gün kargoya verilir. Teslim süresi bulunduğunuz ile göre değişir.' },
            EXCHANGE_FAQ
        ]
    },
    {
        slug: 'kadin-bot-ve-cizme',
        name: 'Kadın Bot ve Çizme',
        nav: 'Bot ve Çizme',
        h1: 'Kadın Bot ve Çizme Modelleri',
        title: 'Kadın Bot ve Çizme Modelleri | Nokta Ayakkabıcılık',
        description: ({ min }) => `Topuklu bot, su geçirmez bot, askeri bot ve çizme modelleri ${min}'den başlayan fiyatlarla. 17:00'ye kadar siparişte aynı gün kargo, iade ve değişim garantisi.`,
        intro: ({ count }) => `Soğuk ve yağışlı günler için su geçirmez botlardan topuklu çizmelere ${count} kadın bot ve çizme modeli.`,
        audience: 'female',
        match: (p) => p.generic && isWomenBoot(p),
        guide: [
            ['Kış için bot seçimi', [
                'Yağmur ve karda su geçirmez ya da kalın tabanlı modeller ayağı kuru tutar. Şehir ve ofis kullanımında topuklu ve küt burun botlar pantolon ve eteklerle uyum sağlar; çizmeler ise elbise ve tayt kombinlerinde bacağı soğuktan korur.'
            ]],
            ['Numara ve kalıp', [
                'Botu kalın çorapla giyecekseniz ve iki numara arasında kalıyorsanız genellikle büyük numara daha rahat eder. Kararsız kaldığınız modeli Instagram\'dan bize sorabilirsiniz.'
            ]]
        ],
        faq: [
            (items) => items.some((p) => /su geçirmez/.test(p.t))
                ? { q: 'Su geçirmez kadın bot modeliniz var mı?', a: 'Evet. Su geçirmez kadın ve unisex bot modellerimiz bu sayfada listelenir; ürün adında "Su Geçirmez" ifadesi yer alır.' }
                : null,
            SHIPPING_FAQ,
            EXCHANGE_FAQ
        ]
    },
    {
        slug: 'erkek-ayakkabi-ve-bot',
        name: 'Erkek Ayakkabı ve Bot',
        nav: 'Erkek',
        h1: 'Erkek Klasik Ayakkabı ve Bot Modelleri',
        title: 'Erkek Klasik Ayakkabı ve Bot Modelleri | Nokta Ayakkabıcılık',
        description: ({ min }) => `Oxford klasik ayakkabı, rugan ayakkabı ve deri erkek bot modelleri ${min}'den başlayan fiyatlarla. Aynı gün kargo, iade ve değişim garantisi.`,
        intro: () => 'Takım elbise için Oxford klasik ayakkabılardan kış boyu giyilecek botlara erkek modelleri.',
        audience: 'male',
        match: (p) => p.generic && isMen(p) && !isKids(p),
        guide: [
            ['Klasik ayakkabı mı, bot mu?', [
                'Oxford ayakkabılar takım elbise ve kumaş pantolonla resmi kombinlerin temelidir. Rugan modeller düğün ve davetlerde, mat deri modeller iş günlerinde öne çıkar. Botlar ise kot ve kargo pantolonla kış boyunca günlük kullanım içindir.'
            ]]
        ],
        faq: [SHIPPING_FAQ, EXCHANGE_FAQ, PAYMENT_FAQ]
    }
];

const MAIN_CATEGORIES = CATEGORIES.filter((c) => !c.parent);
const categoryBySlug = new Map(CATEGORIES.map((c) => [c.slug, c]));

for (const category of CATEGORIES) {
    category.items = products.filter(category.match);
    const prices = category.items.map((p) => p.price);
    category.stats = {
        count: category.items.length,
        min: prices.length ? formatPrice(Math.min(...prices)) : '',
        max: prices.length ? formatPrice(Math.max(...prices)) : ''
    };
    category.url = `/kategori/${category.slug}/`;
}
const activeCategories = CATEGORIES.filter((c) => c.items.length > 0);

// Ürün sayfası üretilecek ürünler ve ana kategorileri
const pageProducts = products.filter((p) => p.generic);
for (const p of pageProducts) {
    p.url = `/urun/${p.slug}/`;
    p.mainCategory = MAIN_CATEGORIES.find((c) => c.items.includes(p) && c.items.length > 0) || null;
    p.collections = CATEGORIES.filter((c) => c.parent && c.items.includes(p));
}

// ---------------------------------------------------------------------------
// Ürün açıklaması (yalnızca başlıktaki bilgilerden üretilir)
// ---------------------------------------------------------------------------
const COLORS = ['acı kahve', 'siyah', 'beyaz', 'bej', 'bordo', 'kahve', 'şeffaf', 'gümüş', 'gold', 'altın','pembe', 'mavi', 'kırmızı', 'yeşil', 'gri', 'lacivert', 'ten'];
const MATERIALS = [['süet', 'süet'], ['rugan', 'rugan'], ['keten', 'keten'], ['deri', 'deri'], ['örme', 'örme'], ['likralı', 'likralı'], ['mat', 'mat']];

function productFacts(p) {
    const t = p.t;
    const color = COLORS.find((c) => new RegExp(`(^|\\s)${c}(\\s|$)`).test(t)) || '';
    const materials = MATERIALS.filter(([key]) => new RegExp(`(^|\\s)${key}(\\s|$)`).test(t)).map(([, label]) => label);
    return { color, materials };
}

function productDescription(p) {
    const t = p.t;
    const { color, materials } = productFacts(p);
    const sentences = [];

    if (isHeel(p)) {
        const heel = /kadeh/.test(t) ? 'kadeh topuklu' : /kısa topuk/.test(t) ? 'kısa topuklu' : /uzun topuk|yüksek topuk/.test(t) ? 'uzun topuklu'
            : /ince topuk/.test(t) ? 'ince topuklu' : /kalın topuk/.test(t) ? 'kalın topuklu' : 'topuklu';
        const kind = /terlik/.test(t) ? 'topuklu terlik' : /önü açık/.test(t) ? `önü açık ${heel} kadın ayakkabı` : `${heel} kadın ayakkabı`;
        const colorPhrase = color === 'şeffaf' ? 'şeffaf görünümlü, ' : color ? `${color} renkli, ` : '';
        sentences.push(`${p.name}, Nokta Shic koleksiyonundan ${colorPhrase}${kind} modelidir.`);
        const details = [];
        if (materials.length) details.push(`${materials.join(' ve ')} yüzeyi`);
        if (/küt burun/.test(t)) details.push('küt burun kalıbı');
        if (/taşlı/.test(t)) details.push('taş detayları');
        if (/simli/.test(t)) details.push('simli dokusu');
        if (/tokalı/.test(t)) details.push('toka detayı');
        if (/kurdeleli/.test(t)) details.push('kurdele detayı');
        if (/(gold|gümüş|altın) (detaylı|desenli)/.test(t)) details.push('metal tonlu detayları');
        if (details.length) sentences.push(`${capFirst(details.join(', ').replace(/, ([^,]*)$/, ' ve $1'))} ile öne çıkar.`);
        if (/terlik/.test(t)) {
            sentences.push('Yaz davetlerinde ve şık günlük kombinlerde kolayca kullanılır.');
        } else if (/simli|taşlı|kurdeleli|şeffaf|gümüş|gold/.test(t)) {
            sentences.push('Düğün, nişan ve davetlerde abiye kombinlerinizi tamamlar.');
        } else if (/kısa topuk/.test(t)) {
            sentences.push('Kısa topuk yapısıyla ofiste ve günlük kombinlerde gün boyu kullanılabilir.');
        } else {
            sentences.push('Ofis, günlük kullanım ve akşam davetleri arasında kolayca geçiş yapar.');
        }
    } else if (isKids(p)) {
        sentences.push(`${p.name}, çocuklar için tasarlanmış ${/ortopedik/.test(t) ? 'ortopedik destekli ' : ''}bir sneaker modelidir.`);
        if (/ışıklı/.test(t)) sentences.push('Işıklı tabanıyla çocukların en sevdiği detayları taşır.');
        if (/hafif/.test(t)) sentences.push('Hafif yapısıyla günlük kullanım için tasarlanmıştır.');
    } else if (/oxford|klasik/.test(t)) {
        sentences.push(`${p.name}, ${materials.length ? `${materials.join(' ve ')} ` : ''}Oxford kalıbında klasik bir erkek ayakkabısıdır.`);
        sentences.push('Takım elbise ve kumaş pantolonla iş günlerinde, düğün ve davetlerde rahatça kullanılır.');
    } else {
        const kind = /çizme/.test(t) ? 'çizme' : 'bot';
        const who = /unisex/.test(t) ? 'unisex' : /erkek/.test(t) || p.category === 'Erkek Bot' ? 'erkek' : 'kadın';
        sentences.push(`${p.name}, ${color ? `${color} renkli ` : ''}bir ${who} ${kind} modelidir.`);
        const details = [];
        if (/topuk/.test(t)) details.push('topuklu formu');
        if (/tozluklu|çıkartılabilir/.test(t)) details.push('çıkarılabilir tozluk detayı');
        if (/yumuşak taban/.test(t)) details.push('yumuşak tabanı');
        if (/askeri/.test(t)) details.push('askeri bot kalıbı');
        if (/küt burun/.test(t)) details.push('küt burun kalıbı');
        if (materials.length) details.push(`${materials.join(' ve ')} yüzeyi`);
        if (details.length) sentences.push(`${capFirst(details.join(', ').replace(/, ([^,]*)$/, ' ve $1'))} ile öne çıkar.`);
        sentences.push(/su geçirmez/.test(t)
            ? 'Su geçirmez yapısı sayesinde yağmurlu ve karlı günlerde ayağı kuru tutar.'
            : 'Sonbahar ve kış kombinleri için uygundur.');
    }

    if (p.sizes) sentences.push(`${p.sizes} numara aralığında sunulur.`);
    return sentences.join(' ');
}

// ---------------------------------------------------------------------------
// Ortak şablon parçaları
// ---------------------------------------------------------------------------
const navLinks = () => MAIN_CATEGORIES.filter((c) => c.items.length)
    .map((c) => `<a href="${c.url}">${esc(c.nav || c.name)}</a>`).join('');

function layout({ title, description, canonical, ogType = 'website', ogImage, ogImageAlt, schema = [], body, bodyAttrs = '', preloadImage = '' }) {
    const image = ogImage || `${SITE}/og-image.jpg`;
    return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="Nokta Ayakkabıcılık">
<meta property="og:locale" content="tr_TR">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(ogImageAlt || title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="theme-color" content="#151515">
<link rel="icon" type="image/png" href="/logo-transparent.png">
<link rel="apple-touch-icon" href="/logo-transparent.png">
<link rel="preconnect" href="https://cdn.shopier.app">
${preloadImage ? `<link rel="preload" as="image" href="${esc(preloadImage)}" fetchpriority="high">\n` : ''}<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,560;9..144,650&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site-pages.css">
${schema.map(jsonLd).join('\n')}
<script src="/assets/nokta-pixel.js" defer></script>
<script src="/consent.js" defer></script>
</head>
<body${bodyAttrs}>
<a class="skip-link" href="#icerik">İçeriğe geç</a>
<header class="sp-header">
  <div class="sp-wrap sp-header-inner">
    <a class="sp-logo" href="/" aria-label="Nokta Ayakkabıcılık ana sayfa"><img src="/logo-transparent.png" alt="Nokta Ayakkabıcılık" width="120" height="34"></a>
    <nav class="sp-nav" aria-label="Kategoriler">${navLinks()}<a href="/#urunler">Tüm modeller</a></nav>
    <a class="sp-ig" href="${INSTAGRAM}" target="_blank" rel="noopener noreferrer">Instagram</a>
  </div>
</header>
<main id="icerik">
${body}
</main>
${footer()}
</body>
</html>
`;
}

function footer() {
    const cats = activeCategories.map((c) => `<li><a href="${c.url}">${esc(c.name)}</a></li>`).join('');
    return `<footer class="sp-footer">
  <div class="sp-wrap sp-footer-grid">
    <div class="sp-footer-brand">
      <a href="/" class="sp-logo"><img src="/logo-transparent.png" alt="Nokta Ayakkabıcılık" width="110" height="31" loading="lazy"></a>
      <p>Nokta Ayakkabıcılık; 30 yıllık mağaza tecrübesi ve 2 fiziki şubesiyle seçtiği ayakkabı, bot ve topuklu modellerini Shopier üzerinden tüm Türkiye'ye gönderir.</p>
    </div>
    <div><h2>Kategoriler</h2><ul>${cats}<li><a href="/katalog.html">Tüm katalog</a></li></ul></div>
    <div><h2>Yardım</h2><ul>
      <li><a href="/bilgilendirme.html#kargo">Kargo ve teslimat</a></li>
      <li><a href="/bilgilendirme.html#iade">İade ve değişim</a></li>
      <li><a href="/bilgilendirme.html#kvkk">KVKK ve gizlilik</a></li>
      <li><button type="button" class="legal-link-button" data-consent-open>Çerez tercihleri</button></li>
    </ul></div>
    <div><h2>İletişim</h2><ul>
      <li><a href="${INSTAGRAM}" target="_blank" rel="noopener noreferrer">Instagram @nokta.ayakkabicilik</a></li>
      <li><a href="${INSTAGRAM_SHIC}" target="_blank" rel="noopener noreferrer">Instagram @noktashic</a></li>
      <li><a href="${SHOPIER}" target="_blank" rel="noopener noreferrer">Shopier mağazası</a></li>
    </ul></div>
  </div>
  <div class="sp-wrap sp-footer-bottom"><span>© ${BUILD_DATE.slice(0, 4)} Nokta Ayakkabıcılık</span><span>Güvenli ödeme · 17:00'ye kadar aynı gün kargo · İade ve değişim garantisi</span></div>
</footer>`;
}

const trustList = `<ul class="sp-trust">
  <li><strong>Aynı gün kargo</strong><span>17:00'ye kadar verilen siparişler</span></li>
  <li><strong>İade ve değişim</strong><span>garantisi</span></li>
  <li><strong>Güvenli ödeme</strong><span>Shopier altyapısı</span></li>
  <li><strong>30 yıllık mağaza</strong><span>2 fiziki şube</span></li>
</ul>`;

function breadcrumbs(items) {
    const html = `<nav class="sp-crumbs" aria-label="Sayfa yolu"><ol>${items.map((item, i) => i === items.length - 1
        ? `<li aria-current="page">${esc(item.name)}</li>`
        : `<li><a href="${item.url}">${esc(item.name)}</a></li>`).join('')}</ol></nav>`;
    const schema = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: items.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: item.name, item: `${SITE}${item.url}` }))
    };
    return { html, schema };
}

function productCard(p, { eager = false } = {}) {
    return `<li class="sp-card">
  <a href="${p.url}" class="sp-card-link">
    <span class="sp-card-img"><img src="${esc(p.images[0])}" alt="${esc(p.name)}" loading="${eager ? 'eager' : 'lazy'}" decoding="async" width="600" height="600"></span>
    <span class="sp-card-body"><span class="sp-card-title">${esc(p.name)}</span>${p.sizes ? `<span class="sp-card-size">${esc(p.sizes)} numara</span>` : ''}<span class="sp-card-price">${formatPrice(p.price)}</span></span>
  </a>
</li>`;
}

function faqBlock(list) {
    if (!list.length) return { html: '', schema: null };
    const html = `<section class="sp-faq" aria-labelledby="sss"><h2 id="sss">Sık sorulan sorular</h2>${list
        .map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</section>`;
    const schema = {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: list.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } }))
    };
    return { html, schema };
}

const organizationRef = { '@type': 'Organization', '@id': `${SITE}/#organization`, name: 'Nokta Ayakkabıcılık', url: `${SITE}/` };

// ---------------------------------------------------------------------------
// Sayfa üreticileri
// ---------------------------------------------------------------------------
function renderCategory(category) {
    const { count, min } = category.stats;
    const parent = category.parent ? categoryBySlug.get(category.parent) : null;
    const crumbItems = [{ name: 'Ana Sayfa', url: '/' }];
    if (parent) crumbItems.push({ name: parent.name, url: parent.url });
    crumbItems.push({ name: category.name, url: category.url });
    const crumbs = breadcrumbs(crumbItems);
    const faqList = category.faq.map((f) => (typeof f === 'function' ? f(category.items) : f)).filter(Boolean);
    const faq = faqBlock(faqList);
    const children = CATEGORIES.filter((c) => c.parent === category.slug && c.items.length);
    const siblings = parent ? CATEGORIES.filter((c) => c.parent === parent.slug && c !== category && c.items.length) : [];
    const chips = [...children, ...siblings];
    const otherMain = MAIN_CATEGORIES.filter((c) => c !== category && c !== parent && c.items.length);

    const itemList = {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: category.h1,
        description: category.description(category.stats),
        url: `${SITE}${category.url}`,
        isPartOf: { '@type': 'WebSite', '@id': `${SITE}/#website`, name: 'Nokta Ayakkabıcılık', url: `${SITE}/` },
        mainEntity: {
            '@type': 'ItemList',
            numberOfItems: count,
            itemListElement: category.items.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE}${p.url}`, name: p.name }))
        }
    };

    const guide = category.guide.map(([heading, paragraphs]) => `<h2>${esc(heading)}</h2>${paragraphs.map((text) => `<p>${text}</p>`).join('')}`).join('');

    const body = `<div class="sp-wrap">
${crumbs.html}
<section class="sp-hero">
  <h1>${esc(category.h1)}</h1>
  <p class="sp-lead">${esc(category.intro(category.stats))}</p>
  <p class="sp-meta"><strong>${count} model</strong> · ${esc(min)}'den başlayan fiyatlar · Shopier ile güvenli ödeme</p>
  ${chips.length ? `<nav class="sp-chips" aria-label="İlgili koleksiyonlar">${chips.map((c) => `<a href="${c.url}">${esc(c.name)}</a>`).join('')}</nav>` : ''}
</section>
<ul class="sp-grid">${category.items.map((p, i) => productCard(p, { eager: i < 6 })).join('')}</ul>
${trustList}
<section class="sp-guide">${guide}</section>
${faq.html}
${otherMain.length ? `<section class="sp-more"><h2>Diğer kategoriler</h2><div class="sp-chips">${otherMain.map((c) => `<a href="${c.url}">${esc(c.name)}</a>`).join('')}<a href="/#urunler">Tüm modeller</a></div></section>` : ''}
</div>`;

    return layout({
        title: category.title,
        description: category.description(category.stats),
        canonical: `${SITE}${category.url}`,
        ogImage: category.items[0]?.images[0],
        ogImageAlt: category.h1,
        schema: [itemList, crumbs.schema, faq.schema].filter(Boolean),
        body
    });
}

function renderProduct(p) {
    const crumbItems = [{ name: 'Ana Sayfa', url: '/' }];
    if (p.mainCategory) crumbItems.push({ name: p.mainCategory.name, url: p.mainCategory.url });
    crumbItems.push({ name: p.name, url: p.url });
    const crumbs = breadcrumbs(crumbItems);
    const description = productDescription(p);
    const { color, materials } = productFacts(p);
    const pageUrl = `${SITE}${p.url}`;
    const priceText = formatPrice(p.price);

    // Google ~60 karakterden sonrasını keser: önce fiyatlı, sığmazsa kısa marka ekiyle.
    const metaTitle = [
        `${p.name} – ${priceText} | Nokta Ayakkabıcılık`,
        `${p.name} | Nokta Ayakkabıcılık`,
        `${p.name} | Nokta`
    ].find((candidate) => candidate.length <= 62) || `${p.name} | Nokta`;
    const metaDescription = truncate(`${p.name}${p.sizes ? `, ${p.sizes} numara` : ''}, ${priceText}. 17:00'ye kadar verilen siparişler aynı gün kargoda. İade ve değişim garantisi, Shopier ile güvenli ödeme.`, 160);

    const audience = p.mainCategory?.audience || (/unisex/.test(p.t) ? 'unisex' : isKids(p) ? null : null);
    const brand = isHeel(p) ? 'Nokta Shic' : null;
    const productSchema = {
        '@context': 'https://schema.org',
        '@type': 'Product',
        '@id': `${pageUrl}#product`,
        name: p.name,
        description,
        image: p.images,
        sku: String(p.id),
        url: pageUrl,
        category: isHeel(p) ? 'Ayakkabı > Kadın > Topuklu Ayakkabı' : isWomenBoot(p) ? 'Ayakkabı > Kadın > Bot ve Çizme' : isKids(p) ? 'Ayakkabı > Çocuk' : 'Ayakkabı > Erkek',
        ...(brand ? { brand: { '@type': 'Brand', name: brand } } : {}),
        ...(color ? { color: capFirst(color) } : {}),
        ...(materials.length ? { material: materials.map(capFirst).join(', ') } : {}),
        ...(audience ? { audience: { '@type': 'PeopleAudience', suggestedGender: /unisex/.test(p.t) ? 'unisex' : audience } } : {}),
        offers: {
            '@type': 'Offer',
            url: pageUrl,
            priceCurrency: 'TRY',
            price: p.price.toFixed(2),
            availability: 'https://schema.org/InStock',
            itemCondition: 'https://schema.org/NewCondition',
            seller: organizationRef
        }
    };

    const related = pageProducts
        .filter((other) => other !== p && p.mainCategory && other.mainCategory === p.mainCategory)
        .sort((a, b) => {
            const shared = (x) => x.collections.filter((c) => p.collections.includes(c)).length;
            return shared(b) - shared(a) || Math.abs(a.price - p.price) - Math.abs(b.price - p.price);
        })
        .slice(0, 8);

    const gallery = p.images.length > 1
        ? `<div class="sp-thumbs" role="list">${p.images.map((src, i) => `<button type="button" role="listitem" class="sp-thumb${i === 0 ? ' is-active' : ''}" data-src="${esc(src)}" aria-label="${i + 1}. görseli göster"><img src="${esc(src)}" alt="" loading="lazy" width="80" height="80"></button>`).join('')}</div>`
        : '';

    const body = `<div class="sp-wrap">
${crumbs.html}
<article class="sp-product" data-product-id="${esc(p.shopierId)}" data-product-name="${esc(p.name)}" data-product-price="${p.price}">
  <div class="sp-gallery">
    <div class="sp-main-img"><img id="sp-main-img" src="${esc(p.images[0])}" alt="${esc(p.name)}${color ? ` – ${color} renk` : ''}" width="900" height="900" fetchpriority="high" decoding="async"></div>
    ${gallery}
  </div>
  <div class="sp-info">
    ${p.mainCategory ? `<a class="sp-eyebrow" href="${p.mainCategory.url}">${esc(p.mainCategory.name)}</a>` : ''}
    <h1>${esc(p.name)}</h1>
    <p class="sp-price">${priceText}</p>
    ${p.sizes ? `<p class="sp-sizes"><span>Numara aralığı</span><strong>${esc(p.sizes)}</strong></p>` : ''}
    <a class="sp-buy" href="${esc(p.shopierUrl)}" target="_blank" rel="noopener" data-shopier="${esc(p.shopierId)}">Shopier'de satın al</a>
    <a class="sp-ask" href="${INSTAGRAM}" target="_blank" rel="noopener noreferrer">Numara veya stok sorusu için Instagram'dan yazın</a>
    ${trustList}
    <section class="sp-desc" aria-labelledby="urun-hakkinda">
      <h2 id="urun-hakkinda">Ürün hakkında</h2>
      <p>${esc(description)}</p>
      <h2>Kargo, iade ve değişim</h2>
      <p>Saat 17:00'ye kadar verilen siparişler aynı gün, sonrakiler genellikle ertesi gün kargoya teslim edilir. Ödeme Shopier'in güvenli altyapısıyla yapılır; numara uymazsa <a href="/bilgilendirme.html#iade">iade ve değişim</a> için Instagram'dan bize yazabilirsiniz.</p>
      ${p.collections.length ? `<p class="sp-chips">${p.collections.map((c) => `<a href="${c.url}">${esc(c.name)}</a>`).join('')}</p>` : ''}
    </section>
  </div>
</article>
${related.length ? `<section class="sp-related" aria-labelledby="benzer"><h2 id="benzer">Benzer modeller</h2><ul class="sp-grid">${related.map((r) => productCard(r)).join('')}</ul></section>` : ''}
</div>
${gallery ? `<script>
document.addEventListener('click',function(e){var b=e.target.closest('.sp-thumb');if(!b)return;var m=document.getElementById('sp-main-img');m.src=b.getAttribute('data-src');document.querySelectorAll('.sp-thumb').forEach(function(x){x.classList.toggle('is-active',x===b);});});
</script>` : ''}`;

    return layout({
        title: metaTitle,
        description: metaDescription,
        canonical: pageUrl,
        ogType: 'product',
        ogImage: p.images[0],
        ogImageAlt: p.name,
        schema: [productSchema, crumbs.schema],
        body,
        preloadImage: p.images[0]
    });
}

// ---------------------------------------------------------------------------
// Yaz
// ---------------------------------------------------------------------------
function write(relPath, content) {
    const full = join(OUT, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
}

rmSync(join(OUT, 'kategori'), { recursive: true, force: true });
rmSync(join(OUT, 'urun'), { recursive: true, force: true });

for (const category of activeCategories) write(`kategori/${category.slug}/index.html`, renderCategory(category));
for (const p of pageProducts) write(`urun/${p.slug}/index.html`, renderProduct(p));

// sitemap.xml (+ görsel sitemap)
const urlEntry = (loc, { lastmod, images = [] } = {}) => `  <url>
    <loc>${esc(loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}${images.map((src) => `\n    <image:image><image:loc>${esc(src)}</image:loc></image:image>`).join('')}
  </url>`;

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${[
        urlEntry(`${SITE}/`),
        urlEntry(`${SITE}/katalog.html`),
        ...activeCategories.map((c) => urlEntry(`${SITE}${c.url}`)),
        ...pageProducts.map((p) => urlEntry(`${SITE}${p.url}`, { images: p.images.slice(0, 5) })),
        urlEntry(`${SITE}/bilgilendirme.html`)
    ].join('\n')}
</urlset>
`;
write('sitemap.xml', sitemap);

console.log(`SEO sayfaları üretildi → ${OUT}`);
console.log(`  Kategori sayfası: ${activeCategories.length} (${activeCategories.map((c) => `${c.slug}:${c.items.length}`).join(', ')})`);
console.log(`  Ürün sayfası:     ${pageProducts.length} / ${products.length} ürün (marka adı geçen ${products.length - pageProducts.length} ürün atlandı)`);
console.log(`  sitemap.xml:      ${2 + activeCategories.length + pageProducts.length + 1} URL`);
