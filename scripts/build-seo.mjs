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

// Google ürün sonuçlarında gösterilen kargo süresi ve iade politikası. Değerler değişirse yalnızca burayı güncelleyin.
// handling: kargoya veriliş (17:00'ye kadar aynı gün, sonrası ertesi gün); transit: kargonun yolda geçirdiği süre.
const DELIVERY = { cutoff: '17:00:00+03:00', handling: [0, 1], transit: [1, 3] };
// Mesafeli satışta yasal cayma süresi 14 gündür; mağaza daha uzun süre tanıyorsa artırın.
const RETURN_DAYS = 14;
const RETURN_POLICY = {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: 'TR',
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: RETURN_DAYS,
    returnMethod: 'https://schema.org/ReturnByMail',
    merchantReturnLink: `${SITE}/bilgilendirme.html#iade`
};
const SHIPPING_DETAILS = {
    '@type': 'OfferShippingDetails',
    // Shopier mağazası: "Bu dükkandaki tüm ürünler ücretsiz kargo ile gönderilir."
    shippingRate: { '@type': 'MonetaryAmount', value: 0, currency: 'TRY' },
    shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'TR' },
    deliveryTime: {
        '@type': 'ShippingDeliveryTime',
        cutoffTime: DELIVERY.cutoff,
        handlingTime: { '@type': 'QuantitativeValue', minValue: DELIVERY.handling[0], maxValue: DELIVERY.handling[1], unitCode: 'DAY' },
        transitTime: { '@type': 'QuantitativeValue', minValue: DELIVERY.transit[0], maxValue: DELIVERY.transit[1], unitCode: 'DAY' }
    }
};

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
            stock: Number.isFinite(p.stock) ? p.stock : null,
            sizeStock: Array.isArray(p.sizeStock) ? p.sizeStock : null,
            generic: !THIRD_PARTY_BRANDS.test(title),
            slug: `${slugify(name)}-${p.id}`,
            t: lower(name)
        };
    })
    .filter((p) => p.images.length);

// Arama verisine göre ürün sayfası başlığı (title) ve H1 iyileştirmesi. URL (slug) değişmez, sadece görünen başlık.
// Search Console: "tozluklu bot" ve "tozluklu çizme" aramaları (Kas 2026).
const SEO_TITLES = {
    103: { title: 'Tozluklu Çizme Siyah – Çıkarılabilir Tozluklu Bot', h1: 'Tozluklu Çizme – Siyah, Çıkarılabilir Tozluklu Kadın Bot' },
    104: { title: 'Tozluklu Çizme Acı Kahve – Çıkarılabilir Tozluklu Bot', h1: 'Tozluklu Çizme – Acı Kahve, Çıkarılabilir Tozluklu Kadın Bot' }
};

const isHeel = (p) => p.category === 'Topuklu Nokta Shic';
const isWomenBoot = (p) => p.category === 'Kadın Bot';
const isMen = (p) => p.category === 'Erkek Bot' || /oxford|erkek|unisex/.test(p.t);
const isKids = (p) => p.category === 'Çocuk Sneakers' || /çocuk/.test(p.t);

// ---------------------------------------------------------------------------
// Kategori ve koleksiyon tanımları
// ---------------------------------------------------------------------------
const SHIPPING_FAQ = {
    q: 'Kargo ücretli mi, siparişim ne zaman kargoya verilir?',
    a: 'Tüm siparişler ücretsiz kargo ile gönderilir. Saat 17:00\'ye kadar verilen siparişler aynı gün, sonrakiler genellikle ertesi gün kargoya teslim edilir.'
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
        description: ({ min }) => `Kadeh, kısa, ince ve önü açık topuklu ayakkabı modelleri ${min}'den başlayan fiyatlarla. Ücretsiz ve aynı gün kargo, iade ve değişim garantisi.`,
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
            ['Topuk boyu rehberi: 3, 5, 7 ve 10 cm', [
                '<strong>3-5 cm (kısa topuk):</strong> Gün boyu ayakta kalınan iş günleri, okul ve günlük kullanım için en rahat aralık. Topuklu ayakkabıya yeni başlayanlar için de iyi bir başlangıçtır.',
                '<strong>5-7 cm (orta ve kadeh topuk):</strong> Ofisten akşam davetine geçilen günlerin dengeli seçimi. Kadeh topuk bu yükseklikte zeminde daha sağlam durur.',
                '<strong>8-10 cm ve üzeri (ince ve uzun topuk):</strong> Düğün, nişan ve gece davetleri için. Uzun süre ayakta kalınacaksa yedek olarak kısa topuklu bir model taşımak işinizi kolaylaştırır.',
                'Ürün sayfalarında topuk boyu, modelin topuk tipine göre yaklaşık aralık olarak belirtilir; kesin ölçüyü Instagram\'dan sorabilirsiniz.'
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
        description: ({ min }) => `Kadeh topuk ayakkabı modelleri ${min}'den başlayan fiyatlarla Nokta Shic'te. Ücretsiz ve aynı gün kargo, iade ve değişim garantisi.`,
        intro: ({ count }) => `Kadeh topuk, adını şarap kadehini andıran inceltilmiş formundan alır: ince topuk kadar şık, ondan daha dengeli. Koleksiyondaki ${count} kadeh topuk modelini aşağıda inceleyebilirsiniz.`,
        audience: 'female',
        brand: 'Nokta Shic',
        match: (p) => p.generic && isHeel(p) && /kadeh/.test(p.t),
        guide: [
            ['Kadeh topuk kimler için uygun?', [
                'Kadeh topuklar çoğunlukla 5-7 cm aralığındadır. Yüksek topuğa yeni alışanlar ve aynı gün içinde hem ofiste hem akşam davetinde aynı ayakkabıyı giymek isteyenler için kadeh topuk dengeli bir tercihtir. Kısa ve orta kadeh topuklar günlük kullanımda, kurdeleli ve gümüş detaylı modeller davetlerde öne çıkar.'
            ]],
            ['Kadeh topuk rahat mı?', [
                'Kadeh topuğun üst kısmı geniş olduğu için ağırlık topuğa ince topuklulara göre daha geniş bir yüzeyden biner; bu da yürürken bileğin daha az yalpalamasını sağlar. Yine de rahatlığı en çok topuk boyu belirler: gün boyu giyilecekse kısa ve orta kadeh topuk (3-7 cm), birkaç saatlik davetler için ince kadeh topuk modeller tercih edilir.',
                'Taban ile topuk arasındaki eğim arttıkça ayağın ön kısmına binen yük de artar. İlk kez kadeh topuk alıyorsanız orta yükseklikte, kapalı burunlu veya bilek bantlı bir modelle başlamak iyi bir fikirdir.'
            ]],
            ['Renk seçimi', [
                'Siyah kadeh topuk ayakkabı ofis ve gece kombinlerine kolayca uyar. Bej ve ten tonları bacak hattını uzatır; gümüş ve beyaz modeller ise abiye ve beyaz elbise altında tercih edilir.'
            ]],
            ['Kadeh topuk ayakkabı nasıl kombinlenir?', [
                'Kumaş pantolon ve blazer ceketle ofiste, midi elbise veya pileli etekle akşam yemeklerinde, saten elbiseyle düğün ve nişanlarda kullanılır. Bilek bantlı ve kurdeleli modeller elbiseyle, sade ve küt burunlu modeller pantolonla daha iyi görünür.'
            ]]
        ],
        faq: [
            { q: 'Kadeh topuk ile ince topuk arasındaki fark nedir?', a: 'İnce (stiletto) topuk boydan boya incedir. Kadeh topuk ise üstte geniş başlayıp aşağıda incelir, bu yüzden zeminde daha dengeli durur.' },
            { q: 'Kadeh topuk kaç cm olur?', a: 'Kadeh topuklar çoğunlukla 3 ile 8 cm arasındadır. Kısa kadeh 3-5 cm, orta kadeh 5-7 cm, ince kadeh topuk 6-8 cm civarındadır. Modelin topuk boyunu ürün sayfasındaki özellik tablosunda görebilirsiniz.' },
            { q: 'Kadeh topuk ayakkabı rahat mı?', a: 'Üst kısmı geniş olduğu için ince topuklu modellere göre daha dengeli ve rahattır. Gün boyu kullanım için kısa ve orta kadeh topuk modelleri öneririz.' },
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
        description: ({ min }) => `Kısa ve uzun topuklu, önü açık kadın ayakkabı modelleri ${min}'den başlayan fiyatlarla. Ücretsiz ve aynı gün kargo, iade ve değişim garantisi.`,
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
        title: 'Kısa Topuklu Ayakkabı (3-5 cm) Modelleri | Nokta Shic',
        description: ({ min }) => `Ofis ve günlük kullanım için kısa topuklu kadın ayakkabı modelleri ${min}'den başlayan fiyatlarla. Ücretsiz ve aynı gün kargo, iade ve değişim garantisi.`,
        intro: ({ count, min }) => `Topuklu ayakkabının şıklığını gün boyu taşınabilir bir yükseklikle sunan kısa topuklu modeller ofis, okul ve günlük kombinler için ideal. ${count} model, ${min}'den başlayan fiyatlarla.`,
        audience: 'female',
        brand: 'Nokta Shic',
        match: (p) => p.generic && isHeel(p) && /kısa topuk/.test(p.t),
        guide: [
            ['Neden kısa topuk?', [
                'Kısa topuk genellikle 3-5 cm aralığındadır ve ayağın ön kısmına binen yükü yüksek topuklulara göre azaltır; bu yüzden uzun süre ayakta kalınan günlerde tercih edilir. Küt burunlu modeller parmaklara daha geniş alan bırakır, gold ve gümüş detaylı modeller ise sade kombinlere hareket katar.'
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
        description: ({ min }) => `Davetler için simli, taşlı ve kurdeleli abiye topuklu ayakkabılar ${min}'den başlayan fiyatlarla. Ücretsiz ve aynı gün kargo, iade ve değişim garantisi.`,
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
        description: ({ min }) => `Topuklu bot, su geçirmez bot, askeri bot ve çizme modelleri ${min}'den başlayan fiyatlarla. Ücretsiz ve aynı gün kargo, iade ve değişim garantisi.`,
        intro: ({ count }) => `Soğuk ve yağışlı günler için su geçirmez botlardan topuklu çizmelere ${count} kadın bot ve çizme modeli.`,
        audience: 'female',
        match: (p) => p.generic && isWomenBoot(p),
        guide: [
            ['Kış için bot seçimi', [
                'Yağmur ve karda su geçirmez ya da kalın tabanlı modeller ayağı kuru tutar. Şehir ve ofis kullanımında topuklu ve küt burun botlar pantolon ve eteklerle uyum sağlar; çizmeler ise elbise ve tayt kombinlerinde bacağı soğuktan korur.'
            ]],
            ['Bot mu, çizme mi?', [
                'Bot bileği ya da bileğin hemen üstünü kapatır; pantolon ve kotla en kolay kombinlenen modeldir. Çizme baldıra veya dize kadar uzanır; elbise, etek ve taytla bacağı soğuktan korur. Hem bot hem çizme isteyenler için tozluklu modeller iki görünümü tek üründe birleştirir.'
            ]],
            ['Tozluklu bot nedir?', [
                'Tozluklu botlarda bilek üstündeki örme veya kumaş tozluk bölümü çıkarılabilir. Tozluk takılıyken çizme, çıkarıldığında bot olarak giyilir; böylece aynı ayakkabı hem elbise hem pantolon kombinlerinde kullanılır. <a href="/kategori/tozluklu-cizme/">Tozluklu çizme modellerimizi</a> ve <a href="/rehber/tozluklu-cizme-nasil-kombinlenir/">kombin rehberimizi</a> inceleyebilirsiniz.'
            ]],
            ['Numara ve kalıp', [
                'Botu kalın çorapla giyecekseniz ve iki numara arasında kalıyorsanız genellikle büyük numara daha rahat eder. Kararsız kaldığınız modeli Instagram\'dan bize sorabilirsiniz.'
            ]]
        ],
        faq: [
            (items) => items.some((p) => /su geçirmez/.test(p.t))
                ? { q: 'Su geçirmez kadın bot modeliniz var mı?', a: 'Evet. Su geçirmez kadın ve unisex bot modellerimiz bu sayfada listelenir; ürün adında "Su Geçirmez" ifadesi yer alır.' }
                : null,
            (items) => items.some((p) => /tozluklu/.test(p.t))
                ? { q: 'Tozluklu botun tozluğu çıkarılabiliyor mu?', a: 'Evet. Tozluklu modellerimizde tozluk bölümü çıkarılabilir; takılıyken çizme, çıkarıldığında bot olarak kullanabilirsiniz.' }
                : null,
            { q: 'Bot ile çizme arasındaki fark nedir?', a: 'Bot bileği veya bileğin biraz üstünü kapatır, çizme ise baldıra ya da dize kadar uzanır. Pantolonla bot, elbise ve etekle çizme daha çok tercih edilir.' },
            SHIPPING_FAQ,
            EXCHANGE_FAQ
        ]
    },
    {
        slug: 'tozluklu-cizme',
        parent: 'kadin-bot-ve-cizme',
        name: 'Tozluklu Çizme',
        h1: 'Tozluklu Çizme ve Tozluklu Bot Modelleri',
        title: 'Tozluklu Çizme ve Tozluklu Bot Modelleri | Nokta',
        description: ({ min }) => `Tozluğu çıkarılabilen kadın çizme modelleri: tozlukla çizme, tozluksuz bot olarak giyin. ${min}'den başlayan fiyatlar, ücretsiz ve aynı gün kargo.`,
        intro: ({ count }) => `Tozluğu takılınca çizme, çıkarılınca bot: tek ayakkabıyla iki ayrı görünüm. Tozluklu çizme modellerimizin ${count} renk seçeneğini aşağıda inceleyebilirsiniz.`,
        audience: 'female',
        match: (p) => p.generic && isWomenBoot(p) && /tozluklu/.test(p.t),
        guide: [
            ['Tozluklu çizme nedir?', [
                'Tozluklu çizme, bilek üstüne takılan ve istenince çıkarılabilen bir tozluk bölümüyle gelen kadın botudur. Tozluk takılıyken baldırı saran bir çizme, çıkarıldığında ise bilek boyu bir bot olarak giyilir. Bu yüzden "tozluklu bot" ve "tozluklu çizme" aynı modeli anlatır.'
            ]],
            ['Neden tozluklu çizme?', [
                '<strong>İki ayakkabı yerine bir:</strong> Elbise ve etekle çizme, pantolon ve kotla bot görünümü aynı üründe.',
                '<strong>Soğukta ekstra koruma:</strong> Tozluk baldırı rüzgâr ve soğuktan korur; hava ısınınca çıkarıp bot olarak kullanmaya devam edersiniz.',
                '<strong>Dolapta daha az yer:</strong> Sonbahar ve kış sezonunu tek bir modelle karşılamak isteyenler için pratik bir seçimdir.'
            ]],
            ['Hangi renk?', [
                '<strong>Siyah</strong> tozluklu çizme siyah tayt, koyu kot ve her renk montla uyumludur; ilk tozluklu çizmeniz için en güvenli tercihtir. <strong>Acı kahve</strong> ise krem, bej ve camel tonlarıyla, triko elbise ve kaşe kabanla daha sıcak, sonbahar havası olan kombinler kurar.'
            ]],
            ['Numara seçimi', [
                'Tozluklu çizmeyi kalın çorapla giyecekseniz ve iki numara arasında kalıyorsanız büyük numarayı tercih edin. Ölçü tablosu için <a href="/rehber/ayakkabi-numarasi-nasil-secilir/">ayakkabı numarası rehberimize</a>, kombin fikirleri için <a href="/rehber/tozluklu-cizme-nasil-kombinlenir/">tozluklu çizme kombin rehberimize</a> göz atabilirsiniz.'
            ]]
        ],
        faq: [
            { q: 'Tozluklu çizmenin tozluğu çıkarılabiliyor mu?', a: 'Evet. Tozluk bölümü çıkarılabilir; takılıyken çizme, çıkarıldığında bot olarak giyilir.' },
            { q: 'Tozluklu bot ile tozluklu çizme aynı şey mi?', a: 'Evet. Tozluk takılıyken çizme, çıkarıldığında bot görünümü verdiği için iki isim de aynı modeli anlatır.' },
            { q: 'Tozluklu çizme hangi mevsimde giyilir?', a: 'Sonbahar ve kış için idealdir. Soğuk günlerde tozlukla çizme olarak, daha ılık günlerde tozluk çıkarılıp bot olarak giyilebilir.' },
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
        description: ({ min }) => `Oxford klasik ayakkabı, rugan ayakkabı ve deri erkek bot modelleri ${min}'den başlayan fiyatlarla. Ücretsiz ve aynı gün kargo, iade ve değişim garantisi.`,
        intro: () => 'Takım elbise için Oxford klasik ayakkabılardan kış boyu giyilecek botlara erkek modelleri.',
        audience: 'male',
        match: (p) => p.generic && isMen(p) && !isKids(p),
        guide: [
            ['Klasik ayakkabı mı, bot mu?', [
                'Oxford ayakkabılar takım elbise ve kumaş pantolonla resmi kombinlerin temelidir. Rugan modeller düğün ve davetlerde, mat deri modeller iş günlerinde öne çıkar. Botlar ise kot ve kargo pantolonla kış boyunca günlük kullanım içindir.'
            ]],
            ['Erkek klasik bot nasıl seçilir?', [
                'Klasik erkek botunda deri yüzey hem dayanıklılık hem de şık görünüm sağlar; kahve ve siyah tonlar kumaş pantolonla iş günlerinde, kotla hafta sonlarında kullanılır. Yağmurlu ve karlı günlerde kalın, kaymaz tabanlı modeller ayağı kuru ve sabit tutar.',
                'Botu kalın çorapla giyecekseniz ve iki numara arasında kalıyorsanız büyük numarayı seçmek genellikle daha rahattır.'
            ]]
        ],
        faq: [
            { q: 'Erkek klasik bot takım elbiseyle giyilir mi?', a: 'Sade, ince tabanlı deri botlar kumaş pantolon ve gündelik takımlarla kullanılabilir. Resmi davetlerde ise Oxford klasik ayakkabı daha uygun bir tercihtir.' },
            SHIPPING_FAQ, EXCHANGE_FAQ, PAYMENT_FAQ]
    },
    {
        slug: 'cocuk-sneaker',
        name: 'Çocuk Sneaker',
        nav: 'Çocuk',
        h1: 'Ortopedik Çocuk Sneaker Modelleri',
        title: 'Ortopedik Çocuk Sneaker ve Spor Ayakkabı | Nokta',
        description: ({ min }) => `Ortopedik, hafif ve ışıklı çocuk sneaker modelleri ${min}'den başlayan fiyatlarla. Ücretsiz ve aynı gün kargo, iade ve değişim garantisi.`,
        intro: () => 'Okulda, parkta ve gün boyu oyunda ayağı destekleyen hafif tabanlı ortopedik çocuk sneaker modelleri. Numara seçerken aşağıdaki rehbere göz atmayı unutmayın.',
        audience: 'unisex',
        match: (p) => p.generic && isKids(p),
        guide: [
            ['Ortopedik çocuk ayakkabısı ne işe yarar?', [
                'Ortopedik çocuk ayakkabılarında topuğu saran sert bir <strong>topuk çanağı</strong> ve ayak tabanını destekleyen şekilli bir iç taban bulunur. Bu yapı, yürümeyi yeni öğrenen ve hızla büyüyen ayağın ayakkabı içinde kaymadan, dengeli basmasına yardımcı olur.',
                'Ortopedik ayakkabı bir tedavi aracı değildir. Çocuğunuzun basışında, yürüyüşünde ya da ayak şeklinde dikkatinizi çeken bir durum varsa önce bir çocuk ortopedi uzmanına danışın.'
            ]],
            ['İyi bir çocuk sneakerında nelere bakılır?', [
                '<strong>Hafif taban:</strong> Ağır ayakkabı çocuğu çabuk yorar; elinizde tarttığınızda hafif gelen, ön kısmı kolayca bükülen tabanlar tercih edilir.',
                '<strong>Kaymaz dış taban:</strong> Okul koridorunda ve ıslak zeminde tutunan kauçuk tabanlar düşme riskini azaltır.',
                '<strong>Cırtlı kapama:</strong> Bağcık bağlamayı henüz bilmeyen çocuklar ayakkabısını kendisi giyip çıkarabilir, ayakkabı da her seferinde aynı sıkılıkta oturur.',
                '<strong>Işıklı modeller:</strong> Taban ışıkları akşam saatlerinde çocuğun daha kolay görülmesine yardım eder ve küçükler tarafından çok sevilir.'
            ]],
            ['Çocuk ayakkabısında numara seçimi', [
                'Çocuğun ayağını ayakta, topuğu duvara dayalıyken ölçün ve en uzun parmağın ucuna kadar olan mesafeye yaklaşık 1-1,5 cm pay ekleyin. Bu pay hem yürürken ayağın öne kaymasını hem de birkaç aylık büyümeyi karşılar. Ayrıntılı ölçü tablosu için <a href="/rehber/ayakkabi-numarasi-nasil-secilir/">ayakkabı numarası rehberimize</a> bakabilirsiniz.',
                'Küçük çocukların ayağı birkaç ayda bir numara büyüyebilir; ayakkabının ucuna basıldığında parmak ile burun arasında başparmak genişliği kadar boşluk kalmıyorsa yeni numaraya geçme zamanı gelmiş demektir.'
            ]]
        ],
        faq: [
            { q: 'Çocuk ayakkabısı kaç numara büyük alınmalı?', a: 'Ayak uzunluğuna 1-1,5 cm pay eklenmiş numara idealdir. Çok büyük alınan ayakkabı ayağın içeride kaymasına ve takılıp düşmeye yol açabilir.' },
            { q: 'Ortopedik çocuk ayakkabısı her çocuk için gerekli mi?', a: 'Zorunlu değildir; ancak topuğu saran ve tabanı destekleyen ayakkabılar gün boyu hareketli çocuklarda konforu artırır. Bir ayak sorunu fark ederseniz uzmana danışmanızı öneririz.' },
            SHIPPING_FAQ,
            EXCHANGE_FAQ
        ]
    }
];

// ---------------------------------------------------------------------------
// Rehber yazıları (/rehber/...): markasız, bilgilendirici içerik sayfaları
// ---------------------------------------------------------------------------
const GUIDES = [
    {
        slug: 'beyaz-sneaker-nasil-temizlenir',
        title: 'Beyaz Sneaker Nasıl Temizlenir? Adım Adım Rehber',
        h1: 'Beyaz Sneaker Nasıl Temizlenir?',
        description: 'Beyaz sneaker ve spor ayakkabı evde nasıl temizlenir? Deri, süet ve file modeller için adım adım temizlik, sararan taban ve kurutma ipuçları.',
        lead: 'Beyaz sneaker her kombine uyar ama ilk çamurda eski görünmeye başlar. İyi haber şu: doğru yöntemle evdeki malzemelerle 15-20 dakikada ilk günkü görünümüne çok yaklaştırabilirsiniz. Bu rehberde malzemeye göre temizlik adımlarını, sararan tabanı ve en sık yapılan hataları bulacaksınız.',
        sections: [
            ['Başlamadan önce: malzemeyi tanıyın', [
                'Temizlik yöntemi ayakkabının üst yüzeyine göre değişir. Ayakkabının iç etiketine veya ürün açıklamasına bakın:',
                { list: [
                    '<strong>Deri ve suni deri:</strong> En kolay temizlenen yüzeydir; ılık su ve yumuşak sabuna dayanıklıdır.',
                    '<strong>Süet ve nubuk:</strong> Suyu sevmez. Islak temizlik leke ve sertleşme bırakabilir, kuru yöntemler kullanılır.',
                    '<strong>File, örme ve kanvas:</strong> Kumaş gibi davranır; sabunlu suyla fırçalanabilir ama iyice kurutulması gerekir.'
                ] }
            ]],
            ['Gerekli malzemeler', [
                { list: [
                    'Yumuşak bir fırça (eski bir diş fırçası da olur)',
                    'Ilık su ve sıvı bulaşık deterjanı veya yumuşak sabun',
                    'Mikrofiber bez',
                    'Taban için karbonat (kabartma tozu) ve beyaz sabun',
                    'Süet modeller için süet silgisi veya süet fırçası',
                    'Kurutma için kâğıt havlu veya gazete'
                ] }
            ]],
            ['Adım adım temizlik', [
                { ordered: [
                    '<strong>Bağcıkları ve iç tabanı çıkarın.</strong> Bağcıkları sabunlu ılık suda ayrı bekletip elde yıkayın; iç tabanı nemli bezle silin.',
                    '<strong>Kuru kiri alın.</strong> Ayakkabılar kuruyken fırçayla tabandaki çamuru ve yüzeydeki tozu silkeleyin. Islak toz çamura döner ve yüzeye işler.',
                    '<strong>Sabunlu suyu hazırlayın.</strong> Bir kase ılık suya birkaç damla bulaşık deterjanı ekleyin. Sıcak su yapıştırıcıyı yumuşatabileceği için kullanmayın.',
                    '<strong>Üst yüzeyi fırçalayın.</strong> Fırçayı ıslatıp fazla suyunu silkeleyin, küçük daireler çizerek fırçalayın. Ayakkabıyı suya batırmayın.',
                    '<strong>Köpüğü bezle alın.</strong> Temiz, nemli mikrofiber bezle yüzeydeki sabunu silin.',
                    '<strong>Tabanı temizleyin.</strong> Karbonatı az suyla macun kıvamına getirip tabanın kenarlarına sürün, fırçalayın ve nemli bezle silin.',
                    '<strong>Gölgede kurutun.</strong> İçine kâğıt havlu doldurup oda sıcaklığında, havadar bir yerde kurumaya bırakın.'
                ] }
            ]],
            ['Süet ve nubuk beyaz sneaker', [
                'Süet yüzeyde ilk tercih kuru temizliktir. Kir ve lekeyi süet silgisiyle hafifçe silin, ardından süet fırçasıyla tüyleri tek yönde tarayın. İnatçı lekelerde fırçayı sadece hafif nemlendirin ve ayakkabıyı ıslatmadan çalışın.',
                'Temizlikten sonra uygulanan su ve leke itici sprey, yeni kirin yüzeye işlemesini zorlaştırır.'
            ]],
            ['Sararan taban nasıl beyazlatılır?', [
                'Beyaz tabanlarda sararma çoğunlukla kir birikmesi, güneş ışığı ve kauçuğun zamanla oksitlenmesinden kaynaklanır. Kir kaynaklı sararmada karbonatlı macun ve fırça çoğu zaman yeterlidir. Kenar çizgilerinde ve küçük lekelerde melamin sünger (sihirli sünger) iyi sonuç verir.',
                'Oksitlenmeden kaynaklanan derin sararma ev yöntemleriyle tamamen gitmeyebilir. Bu durumda tabanı aşındırmaya çalışmak yerine düzenli bakımla ilerlemesini durdurmak daha doğrudur.'
            ]],
            ['Yapılmaması gerekenler', [
                { list: [
                    '<strong>Çamaşır makinesi:</strong> Deri ve süet modellerde biçim bozulmasına ve yapıştırıcı açılmasına yol açabilir.',
                    '<strong>Çamaşır suyu:</strong> Beyazlatmak yerine sarı lekeler bırakabilir ve dokuyu yıpratır.',
                    '<strong>Güneşte veya kalorifer üstünde kurutma:</strong> Isı tabanı sarartır, deriyi sertleştirir ve çatlatır.',
                    '<strong>Sert tel fırça:</strong> Deri yüzeyi çizer, kumaşta tüylenme yapar.'
                ] }
            ]],
            ['Beyaz sneakerın uzun süre beyaz kalması için', [
                'Her kullanımdan sonra nemli bezle kısa bir silme, kirin birikmesini önler. Ayakkabıları güneş almayan, kuru bir yerde ve içine kâğıt doldurarak saklamak biçimlerini korur. Yağmurlu günlerde beyaz sneaker yerine su geçirmez bir bot tercih etmek de onları uzun ömürlü kılar; <a href="/kategori/kadin-bot-ve-cizme/">bot modellerimize</a> göz atabilirsiniz.'
            ]]
        ],
        faq: [
            { q: 'Beyaz sneaker çamaşır makinesinde yıkanır mı?', a: 'Deri ve süet modeller makinede yıkanmamalıdır. Kanvas modeller düşük sıcaklıkta yıkanabilir, ancak elde fırçalamak her zaman daha güvenlidir.' },
            { q: 'Beyaz ayakkabı tabanı nasıl beyazlatılır?', a: 'Karbonatı az suyla macun yapıp tabana sürün, fırçalayın ve nemli bezle silin. İnce lekelerde melamin sünger iyi sonuç verir.' },
            { q: 'Diş macunu beyaz ayakkabıyı temizler mi?', a: 'Beyaz ve jel olmayan diş macunu tabandaki küçük lekelerde işe yarayabilir; ancak deri yüzeyde iz bırakabileceği için önce görünmeyen bir yerde deneyin.' },
            { q: 'Islanan ayakkabı nasıl kurutulur?', a: 'İçine kâğıt havlu veya gazete doldurun, ıslandıkça değiştirin ve oda sıcaklığında, güneş ve kalorifer olmayan havadar bir yerde kurutun.' }
        ]
    },
    {
        slug: 'ayakkabi-numarasi-nasil-secilir',
        title: 'Ayakkabı Numarası Nasıl Seçilir? Ölçü Tablosu',
        h1: 'Ayakkabı Numarası Nasıl Seçilir?',
        description: 'Ayak uzunluğunu evde ölçüp doğru ayakkabı numarasını seçin. Kadın, erkek ve çocuk numara tablosu; sneaker, bot ve topuklu için ipuçları.',
        lead: 'İnternetten ayakkabı alırken en büyük soru numaradır. Ayağınızı evde bir kâğıt ve cetvelle birkaç dakikada ölçebilir, aşağıdaki tabloyla numaranızı bulabilirsiniz. Ayrıca sneaker, bot ve topuklu ayakkabıda numara seçerken nelere dikkat etmeniz gerektiğini de anlattık.',
        sections: [
            ['Ayağınızı evde nasıl ölçersiniz?', [
                { ordered: [
                    'Bir A4 kâğıdı duvara dayalı şekilde yere koyun.',
                    'Çorapla ve ayakta durarak topuğunuzu duvara yaslayın.',
                    'En uzun parmağınızın ucunu kâğıda kalemle işaretleyin.',
                    'Duvardan işarete kadar olan mesafeyi santimetre olarak ölçün.',
                    'İki ayağınızı da ölçün; büyük olan ayağı esas alın.'
                ] },
                'Ayak gün içinde hafifçe şiştiği için ölçümü akşam saatlerinde yapmak, gün boyu rahat edeceğiniz numarayı bulmanızı sağlar.'
            ]],
            ['Yetişkin numara tablosu', [
                { table: {
                    head: ['Ayak uzunluğu', 'Numara (EU)'],
                    rows: [
                        ['22,5 cm', '36'], ['23 cm', '36-37'], ['23,5 cm', '37'], ['24 cm', '38'], ['24,5 cm', '39'],
                        ['25 cm', '39-40'], ['25,5 cm', '40'], ['26 cm', '41'], ['26,5 cm', '42'], ['27 cm', '42-43'],
                        ['27,5 cm', '43'], ['28 cm', '44'], ['28,5 cm', '45'], ['29 cm', '45-46']
                    ]
                } },
                'Tablo yaklaşık değerler verir; kalıp markaya ve modele göre yarım numara değişebilir. Ölçünüz iki numara arasında kalıyorsa genellikle büyük numara daha rahat eder.'
            ]],
            ['Çocuk numara tablosu', [
                { table: {
                    head: ['Ayak uzunluğu', 'Numara (EU)'],
                    rows: [
                        ['13 cm', '22'], ['13,5 cm', '22-23'], ['14 cm', '23'], ['14,5 cm', '24'], ['15 cm', '25'],
                        ['16 cm', '26'], ['17 cm', '27-28'], ['18 cm', '29'], ['19 cm', '30-31'], ['20 cm', '32'],
                        ['21 cm', '33-34'], ['22 cm', '35']
                    ]
                } },
                'Çocuklarda ayak uzunluğuna 1-1,5 cm büyüme payı bırakılması önerilir. <a href="/kategori/cocuk-sneaker/">Ortopedik çocuk sneaker modellerimizi</a> bu ölçüye göre seçebilirsiniz.'
            ]],
            ['Sneaker ve spor ayakkabıda numara', [
                'Spor ayakkabılar genellikle normal numaranızla alınır. Kalın çorapla giyecekseniz, ayağınız geniş veya yüksek taraklıysa ya da ölçünüz iki numara arasında kalıyorsa yarım-bir numara büyüğü daha rahat eder. Doğru numarada başparmağınız ile ayakkabının burnu arasında yaklaşık bir parmak eni boşluk kalır ve topuk yürürken yukarı kaymaz.'
            ]],
            ['Botta numara seçimi', [
                'Bot kışın kalın çorapla giyildiği için ölçünüz sınırdaysa bir numara büyük almak çoğu zaman doğru tercihtir. Bilekte fermuar veya bağcık olan modeller ayağı sabitlediği için hafif büyük numarada bile ayak içeride kaymaz. Kış için <a href="/kategori/kadin-bot-ve-cizme/">kadın bot ve çizme</a> ile <a href="/kategori/erkek-ayakkabi-ve-bot/">erkek bot</a> modellerimize göz atabilirsiniz.'
            ]],
            ['Topuklu ayakkabıda numara seçimi', [
                'Topuk yükseldikçe ayak öne doğru kayar, bu yüzden topuklu ayakkabı burun kısmında sıkıyorsa yarım numara büyüğü daha rahat edebilir. Önü açık modellerde parmakların tabandan taşmaması, kapalı burunlu modellerde ise topuğun ayakkabıdan çıkmaması doğru numaranın işaretidir. <a href="/kategori/kadin-topuklu-ayakkabi/">Topuklu ayakkabı modellerimizi</a> inceleyebilirsiniz.'
            ]],
            ['Numara uymazsa ne olur?', [
                'Nokta Ayakkabıcılık\'tan aldığınız ayakkabının numarası uymazsa değişim yapabilirsiniz. Emin olamadığınız durumlarda ayak ölçünüzü ve beğendiğiniz modeli Instagram\'dan yazmanız yeterli, size uygun numarayı birlikte belirleriz. Ayrıntılar <a href="/bilgilendirme.html#iade">iade ve değişim</a> sayfasında.'
            ]]
        ],
        faq: [
            { q: 'Ayak ölçüsü iki numara arasında kalırsa hangisi alınmalı?', a: 'Genellikle büyük numara daha rahat eder; özellikle bot ve kalın çorapla giyilecek ayakkabılarda büyük numarayı tercih edin.' },
            { q: '25 cm ayak kaç numara?', a: '25 cm ayak uzunluğu yaklaşık 39-40 numaraya karşılık gelir. Dar kalıplı modellerde 40 numara daha rahat edebilir.' },
            { q: 'Çocuk ayakkabısında ne kadar pay bırakılmalı?', a: 'Ayak uzunluğuna 1-1,5 cm pay eklenmelidir. Bu pay hem yürürken ayağın öne kaymasını hem de büyümeyi karşılar.' },
            EXCHANGE_FAQ
        ]
    },
    {
        slug: 'tozluklu-cizme-nasil-kombinlenir',
        date: '2026-11-08',
        title: 'Tozluklu Çizme Nasıl Kombinlenir? 6 Kombin Önerisi',
        h1: 'Tozluklu Çizme Nasıl Kombinlenir?',
        description: 'Tozluklu çizme ve tozluklu bot kombin önerileri: elbise, etek, tayt, kot ve pantolonla nasıl giyilir? Tozluklu ve tozluksuz kullanım ipuçları.',
        lead: 'Tozluklu çizmenin en güzel yanı tek ayakkabıyla iki görünüm sunması: tozluk takılıyken çizme, çıkarıldığında bot. Bu rehberde elbiseden kota, ofisten hafta sonuna tozluklu çizmeyi nasıl kombinleyebileceğinizi ve tozluğu ne zaman çıkarmanız gerektiğini anlattık.',
        sections: [
            ['Tozluklu mu, tozluksuz mu?', [
                'Kural basit: bacak ne kadar açıksa tozluk o kadar işe yarar. Elbise, etek ve şortla tozluğu takarak çizme görünümü elde edin. Kot ve kumaş pantolonla ise tozluğu çıkarıp bot olarak giymek daha sade durur. Pantolonun paçası botun üzerine düşüyorsa tozluğa gerek yoktur.'
            ]],
            ['6 tozluklu çizme kombini', [
                { ordered: [
                    '<strong>Triko elbise + tozluklu çizme:</strong> Diz boyu ya da midi triko elbiseyle tozluk takılı giyin. Uzun bir kaban ekleyince soğuk kış günleri için tam kombin olur.',
                    '<strong>Siyah tayt + uzun kazak + siyah tozluklu çizme:</strong> Tek renk siyah, bacağı olduğundan uzun gösterir. Günlük kullanım ve alışveriş için rahat bir kombin.',
                    '<strong>Mini etek + kalın çorap + tozluklu çizme:</strong> Siyah veya ten rengi kalın çorapla tozluğu takın; deri ceket veya oversize blazerla tamamlayın.',
                    '<strong>Dar paça kot + bot görünümü:</strong> Tozluğu çıkarın, kotun paçasını botun içine sokun ya da kıvırın. Puf mont veya kaşe kaban ile hafta sonu kombini.',
                    '<strong>Kumaş pantolon + acı kahve bot:</strong> Ofis için tozluğu çıkarın; krem, bej veya camel tonlarında pantolon ve triko ile acı kahve rengi sıcak bir uyum yakalar.',
                    '<strong>Midi etek + tozluklu çizme:</strong> Eteğin boyu tozluğun üst kısmını hafifçe örtecek şekilde seçin; arada çıplak bacak kalmaması kombini daha bütün gösterir.'
                ] }
            ]],
            ['Renge göre kombin', [
                { list: [
                    '<strong>Siyah tozluklu çizme:</strong> Siyah, gri, lacivert ve beyazla her zaman uyumlu. Desenli elbiseleri sakinleştirir.',
                    '<strong>Acı kahve tozluklu çizme:</strong> Krem, bej, camel, haki ve bordo ile sıcak tonlu sonbahar kombinleri kurar. Mavi kotla da çok iyi gider.'
                ] }
            ]],
            ['Kısa boylular için ipucu', [
                'Tozluklu çizmeyi tayt veya çorapla aynı renkte giymek bacak çizgisini kesintisiz gösterir ve boyu uzun gösterir. Ayakkabı ile etek arasında kalan bölümü kısa tutmak da aynı etkiyi verir.'
            ]],
            ['Bakım', [
                'Tozluğu ayrı saklamak hem biçimini korur hem de botu tozluksuz kullanırken kaybolmasını önler. Islandıktan sonra içine kâğıt doldurup oda sıcaklığında, kaloriferden uzakta kurutun.'
            ]],
            ['Modellerimiz', [
                'Siyah ve acı kahve renk seçenekleriyle <a href="/kategori/tozluklu-cizme/">tozluklu çizme modellerimizi</a> ve diğer <a href="/kategori/kadin-bot-ve-cizme/">kadın bot ve çizme modellerimizi</a> inceleyebilirsiniz.'
            ]]
        ],
        faq: [
            { q: 'Tozluklu çizme pantolonla giyilir mi?', a: 'Evet. Dar paça pantolon ve kotla tozluğu çıkarıp bot olarak giymek en sade sonucu verir; paçayı botun içine de sokabilirsiniz.' },
            { q: 'Tozluklu çizme elbiseyle nasıl giyilir?', a: 'Tozluğu takarak çizme görünümünde giyin; triko ve midi elbiseler, kalın çorap veya tayt ile en iyi sonucu verir.' },
            { q: 'Tozluklu çizme hangi renk alınmalı?', a: 'İlk tozluklu çizmeniz için siyah her kombine uyar. Krem, bej ve camel tonlarını seviyorsanız acı kahve daha sıcak bir görünüm sağlar.' }
        ]
    }
];
GUIDES.forEach((g) => { g.url = `/rehber/${g.slug}/`; });

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

// Başlıktan okunabilen özellikler (özellik tablosu, meta açıklama ve kombin önerisi için)
function productAttributes(p) {
    const t = p.t;
    const { color, materials } = productFacts(p);
    const heel = /ince kadeh/.test(t) ? 'İnce kadeh topuk' : /orta kadeh/.test(t) ? 'Orta kadeh topuk' : /kısa kadeh/.test(t) ? 'Kısa kadeh topuk'
        : /kadeh/.test(t) ? 'Kadeh topuk' : /kısa topuk/.test(t) ? 'Kısa topuk' : /uzun topuk/.test(t) ? 'Uzun topuk'
            : /yüksek topuk/.test(t) ? 'Yüksek topuk' : /ince topuk/.test(t) ? 'İnce topuk' : /kalın topuk/.test(t) ? 'Kalın topuk'
                : /topuk/.test(t) ? 'Topuklu' : '';
    const toe = /önü açık/.test(t) ? 'Önü açık' : /küt burun/.test(t) ? 'Küt burun' : '';
    const details = [
        [/çapraz tokalı/, 'Çapraz toka'], [/(?<!çapraz )tokalı/, 'Toka'], [/kurdeleli/, 'Kurdele'], [/taşlı/, 'Taş işleme'],
        [/simli/, 'Simli doku'], [/gold detaylı/, 'Gold detay'], [/gümüş detaylı/, 'Gümüş detay'], [/altın desenli/, 'Altın desen'],
        [/lastikli/, 'Lastikli bant'], [/tozluklu|çıkartılabilir/, 'Çıkarılabilir tozluk'], [/su geçirmez/, 'Su geçirmez'],
        [/yumuşak taban/, 'Yumuşak taban'], [/askeri/, 'Askeri bot kalıbı'], [/ortopedik/, 'Ortopedik taban'], [/ışıklı/, 'Işıklı taban'], [/hafif/, 'Hafif yapı']
    ].filter(([re]) => re.test(t)).map(([, label]) => label);
    const kind = isHeel(p) ? (/terlik/.test(t) ? 'topuklu terlik' : 'topuklu kadın ayakkabı')
        : isKids(p) ? 'çocuk sneaker'
            : /oxford/.test(t) ? 'Oxford klasik erkek ayakkabı'
                : `${/unisex/.test(t) ? 'unisex' : /erkek/.test(t) || p.category === 'Erkek Bot' ? 'erkek' : 'kadın'} ${/çizme/.test(t) ? 'çizme' : 'bot'}`;
    return { color, materials, heel, toe, details, kind };
}

// Topuk tipine göre yaklaşık topuk boyu. Ürün başına ölçülmüş değer değildir; sayfada "yaklaşık" diye
// gösterilir. Ölçülmüş değer eklenirse (HEEL_CM_OVERRIDES) o kullanılır.
const HEEL_CM = {
    'Kısa topuk': '3-5', 'Kısa kadeh topuk': '3-5', 'Orta kadeh topuk': '5-7', 'Kadeh topuk': '5-7',
    'İnce kadeh topuk': '6-8', 'Kalın topuk': '5-7', 'İnce topuk': '8-10', 'Uzun topuk': '8-10', 'Yüksek topuk': '9-11'
};
// Elle ölçülen topuk boyları: { ürün id: 'cm' }, ör. { 118: '6' }
const HEEL_CM_OVERRIDES = {};
function heelHeight(p) {
    if (HEEL_CM_OVERRIDES[p.id]) return { cm: String(HEEL_CM_OVERRIDES[p.id]), exact: true };
    const { heel } = productAttributes(p);
    return HEEL_CM[heel] ? { cm: HEEL_CM[heel], exact: false } : null;
}

// Meta açıklama: başlığı tekrar etmeden ürünü özetler (seo-programmatic metadata kontrolü)
function productPitch(p) {
    const a = productAttributes(p);
    const ADJ = {
        'Çapraz toka': 'çapraz tokalı', 'Toka': 'tokalı', 'Kurdele': 'kurdeleli', 'Taş işleme': 'taşlı', 'Simli doku': 'simli',
        'Gold detay': 'gold detaylı', 'Gümüş detay': 'gümüş detaylı', 'Altın desen': 'altın desenli', 'Lastikli bant': 'lastikli',
        'Çıkarılabilir tozluk': 'çıkarılabilir tozluklu', 'Su geçirmez': 'su geçirmez', 'Yumuşak taban': 'yumuşak tabanlı',
        'Askeri bot kalıbı': 'askeri model', 'Ortopedik taban': 'ortopedik', 'Işıklı taban': 'ışıklı', 'Hafif yapı': 'hafif'
    };
    const hh = heelHeight(p);
    const heelAdj = !a.heel ? '' : a.heel === 'Topuklu' ? (isHeel(p) ? '' : 'topuklu') : `${lower(a.heel)}lu${hh ? ` (${hh.exact ? '' : '~'}${hh.cm} cm)` : ''}`;
    const kind = heelAdj && isHeel(p) && !/terlik/.test(p.t) ? 'kadın ayakkabı' : a.kind;
    const lead = [a.color, a.materials.join(' '), heelAdj].filter(Boolean).join(' ');
    const extras = [lower(a.toe), ...a.details.map((d) => ADJ[d] || lower(d))].filter(Boolean).slice(0, 3);
    return capFirst([lead, ...extras].filter(Boolean).join(', ') + ` ${kind}`).trim();
}

const STYLE_TIPS = {
    heel: {
        'siyah': 'Siyah topuklu ayakkabı; siyah elbise, kumaş pantolon ve takımlarla en kolay eşleşen renktir. Gündüz ofiste, akşam davette aynı rahatlıkla kullanılır.',
        'bej': 'Bej ve ten tonları bacak hattını uzun gösterir. Beyaz pantolon, pastel elbise ve keten parçalarla bahar-yaz kombinlerinde öne çıkar.',
        'beyaz': 'Beyaz model; nikâh, kına ve yaz davetlerinde beyaz ve pastel kıyafetlerle uyum sağlar, kotla gündüz kombinlerine de taşınabilir.',
        'gümüş': 'Gümüş tonları siyah, gece mavisi ve gri abiyelerle parlak bir kontrast oluşturur; gümüş takılarla kombini bütünler.',
        'gold': 'Gold tonları bordo, zümrüt yeşili ve siyah abiyelerle sıcak bir parıltı verir; altın renkli takılarla birlikte kullanıldığında kombin bütünlenir.',
        'bordo': 'Bordo; siyah, gri ve lacivert kıyafetlerle sonbahar-kış sezonuna uygun bir renk vurgusu yapar.',
        'kahve': 'Kahve tonları kot, krem ve deve tüyü parçalarla doğal bir uyum sağlar; sonbahar kombinlerinde siyaha göre daha yumuşak bir görünüm verir.',
        'şeffaf': 'Şeffaf yüzey ayakkabıyı kıyafetin rengine uydurur; desenli ve renkli elbiselerde bile kombini sade tutar.',
        '': 'Nötr tonlu elbise, etek ve kumaş pantolonlarla kolayca kombinlenir.'
    },
    boot: {
        'siyah': 'Siyah bot; kot, tayt ve kaban ile kış boyunca en çok kombinlenen modeldir.',
        'kahve': 'Kahve tonlu bot; kot, krem triko ve deve tüyü kabanla sonbahar-kış kombinlerine sıcaklık katar.',
        'bej': 'Bej bot; açık renk kot ve krem tonlu trikoyla yumuşak bir kış görünümü sağlar.',
        '': 'Kot pantolon, tayt ve kalın trikolarla sonbahar-kış boyunca kombinlenebilir.'
    }
};

function stylingTip(p) {
    const a = productAttributes(p);
    const tone = a.color === 'acı kahve' ? 'kahve' : a.color === 'altın' ? 'gold' : a.color;
    if (isHeel(p)) return STYLE_TIPS.heel[tone] ?? STYLE_TIPS.heel[''];
    if (isKids(p)) return 'Eşofman, kot ve şortla okul ve oyun günlerinde rahatça kombinlenir.';
    if (/oxford/.test(p.t)) return a.materials.includes('rugan')
        ? 'Rugan Oxford; smokin, koyu renk takım elbise ve düğün kombinleri için uygundur.'
        : 'Deri Oxford; lacivert ve gri takım elbise, kumaş pantolon ve gömlekle iş kombinlerinin temelidir.';
    const base = STYLE_TIPS.boot[tone] ?? STYLE_TIPS.boot[''];
    return /çizme/.test(p.t) ? `${base} Çizme; diz altı elbise ve eteklerle bacağı soğuktan korurken şık bir görünüm verir.` : base;
}

// Shopier her görseli üç boyutta sunar: pictures_small (330), pictures_mid (458), pictures_large (916)
function shopierSrcset(src) {
    if (!/\/pictures_large\//.test(src)) return '';
    return ['small 330w', 'mid 458w', 'large 916w']
        .map((v) => { const [size, w] = v.split(' '); return `${src.replace('/pictures_large/', `/pictures_${size}/`)} ${w}`; })
        .join(', ');
}
const CARD_SIZES = '(max-width:900px) 33vw, 300px';
const MAIN_SIZES = '(max-width:900px) calc(100vw - 32px), 640px';

// ---------------------------------------------------------------------------
// Ortak şablon parçaları
// ---------------------------------------------------------------------------
const navLinks = () => MAIN_CATEGORIES.filter((c) => c.items.length)
    .map((c) => `<a href="${c.url}">${esc(c.nav || c.name)}</a>`).join('');

function layout({ title, description, canonical, ogType = 'website', ogImage, ogImageAlt, schema = [], body, bodyAttrs = '', preloadImage = '', preloadSrcset = '', preloadSizes = '' }) {
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
${preloadImage ? `<link rel="preload" as="image" href="${esc(preloadImage)}"${preloadSrcset ? ` imagesrcset="${esc(preloadSrcset)}" imagesizes="${preloadSizes}"` : ''} fetchpriority="high">\n` : ''}<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,560;9..144,650&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site-pages.css">
${schema.map(jsonLd).join('\n')}
<script src="/assets/nokta-pixel.js" defer></script>
<script src="/assets/nokta-ga.js" defer></script>
<script src="/assets/nokta-sepet.js" defer></script>
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
      ${GUIDES.map((g) => `<li><a href="${g.url}">${esc(g.h1)}</a></li>`).join('')}
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
  <div class="sp-wrap sp-footer-bottom"><span>© ${BUILD_DATE.slice(0, 4)} Nokta Ayakkabıcılık</span><span>Ücretsiz kargo · 17:00'ye kadar aynı gün kargoda · İade ve değişim garantisi · Güvenli ödeme</span></div>
</footer>`;
}

const trustList = `<ul class="sp-trust">
  <li><strong>Ücretsiz kargo</strong><span>17:00'ye kadar siparişte aynı gün</span></li>
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
    <span class="sp-card-img"><img src="${esc(p.images[0])}"${shopierSrcset(p.images[0]) ? ` srcset="${esc(shopierSrcset(p.images[0]))}" sizes="${CARD_SIZES}"` : ''} alt="${esc(p.name)}" loading="${eager ? 'eager' : 'lazy'}" decoding="async" width="600" height="600"></span>
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

// Rehber yazısı. Bölüm içeriği: düz metin (<p>), { list }, { ordered } veya { table: { head, rows } }.
const GUIDE_DATE = '2026-11-02';
function renderGuideBlock(block) {
    if (typeof block === 'string') return `<p>${block}</p>`;
    if (block.list) return `<ul>${block.list.map((li) => `<li>${li}</li>`).join('')}</ul>`;
    if (block.ordered) return `<ol>${block.ordered.map((li) => `<li>${li}</li>`).join('')}</ol>`;
    if (block.table) {
        const { head, rows } = block.table;
        return `<table class="sp-size-table"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    return '';
}

function renderGuide(g) {
    const crumbs = breadcrumbs([{ name: 'Ana Sayfa', url: '/' }, { name: g.h1, url: g.url }]);
    const faq = faqBlock(g.faq);
    const anchor = (heading) => slugify(heading);
    const toc = `<nav class="sp-toc" aria-label="İçindekiler"><h2>İçindekiler</h2><ol>${g.sections
        .map(([heading]) => `<li><a href="#${anchor(heading)}">${esc(heading)}</a></li>`).join('')}</ol></nav>`;
    const sections = g.sections.map(([heading, blocks]) => `<h2 id="${anchor(heading)}">${esc(heading)}</h2>${blocks.map(renderGuideBlock).join('')}`).join('');
    const others = GUIDES.filter((o) => o !== g);
    const cats = activeCategories.filter((c) => !c.parent);
    const article = {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: g.h1,
        description: g.description,
        inLanguage: 'tr-TR',
        datePublished: g.date || GUIDE_DATE,
        dateModified: g.date || GUIDE_DATE,
        mainEntityOfPage: `${SITE}${g.url}`,
        image: `${SITE}/og-image.jpg`,
        author: organizationRef,
        publisher: { ...organizationRef, logo: { '@type': 'ImageObject', url: `${SITE}/logo-transparent.png` } }
    };
    const body = `<div class="sp-wrap">
${crumbs.html}
<article class="sp-article">
<section class="sp-hero">
  <h1>${esc(g.h1)}</h1>
  <p class="sp-lead">${esc(g.lead)}</p>
</section>
${toc}
<section class="sp-guide">${sections}</section>
${faq.html}
</article>
${trustList}
<section class="sp-more"><h2>Kategoriler</h2><div class="sp-chips">${cats.map((c) => `<a href="${c.url}">${esc(c.name)}</a>`).join('')}<a href="/#urunler">Tüm modeller</a></div></section>
${others.length ? `<section class="sp-more"><h2>Diğer rehberler</h2><div class="sp-chips">${others.map((o) => `<a href="${o.url}">${esc(o.h1)}</a>`).join('')}</div></section>` : ''}
</div>`;
    return layout({
        title: `${g.title} | Nokta Ayakkabıcılık`.length <= 60 ? `${g.title} | Nokta Ayakkabıcılık` : g.title,
        description: g.description,
        canonical: `${SITE}${g.url}`,
        ogType: 'article',
        ogImageAlt: g.h1,
        schema: [article, crumbs.schema, faq.schema].filter(Boolean),
        body
    });
}

// Aynı modelin farklı renkleri: başlıktan renk kelimeleri çıkarılınca aynı kalan ürünler
const familyOf = new Map();
function buildFamilies() {
    // Yalnızca ana rengi (başlıkta ilk geçen renk) çıkarır; "gümüş taşlı" gibi detay renkleri modele aittir.
    const removeFirst = (text, main) => {
        const words = text.split(' ');
        const n = main.split(' ').length;
        for (let i = 0; i + n <= words.length; i++) {
            if (lower(words.slice(i, i + n).join(' ')) === main) return [...words.slice(0, i), ...words.slice(i + n)].join(' ').replace(/\s+/g, ' ').trim();
        }
        return text;
    };
    const strip = (p) => lower(removeFirst(p.name, productFacts(p).color || '\u0000'));
    const groups = new Map();
    for (const p of pageProducts) {
        if (!p.mainCategory) continue;
        const key = `${p.mainCategory.slug}|${strip(p)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
    }
    for (const all of groups.values()) {
        // Gruplar renge göre değişir (variesBy color); rengi başlıktan okunamayan ürün gruba girmez,
        // aynı renkten iki ürün varsa ilki kalır. Aksi halde Google "color alanı eksik" hatası verir.
        const seen = new Set();
        const members = all.filter((m) => {
            const c = productFacts(m).color;
            if (!c || seen.has(c)) return false;
            seen.add(c);
            return true;
        });
        if (members.length < 2) continue;
        const first = members[0];
        const name = removeFirst(first.name, productFacts(first).color || '\u0000');
        const family = { name: capFirst(name), slug: slugify(name), members };
        for (const m of members) familyOf.set(m, family);
    }
}

function specsTable(p) {
    const a = productAttributes(p);
    const rows = [
        ['Ürün kodu', `NK-${p.id}`],
        ['Kategori', p.mainCategory ? p.mainCategory.name : isKids(p) ? 'Çocuk ayakkabı' : ''],
        ['Koleksiyon', isHeel(p) ? 'Nokta Shic' : ''],
        ['Renk', a.color ? capFirst(a.color) : ''],
        ['Topuk', a.heel && a.heel !== 'Topuklu' ? a.heel : ''],
        ['Topuk boyu', (() => { const hh = heelHeight(p); return hh ? (hh.exact ? `${hh.cm} cm` : `Yaklaşık ${hh.cm} cm (${lower(a.heel)} sınıfı)`) : ''; })()],
        ['Burun', a.toe],
        ['Yüzey', a.materials.map(capFirst).join(', ')],
        ['Detaylar', a.details.join(', ')],
        ['Numara aralığı', p.sizes],
        ['Stoktaki numaralar', p.sizeStock ? (p.sizeStock.filter((v) => v.stock > 0).map((v) => v.size).join(', ') || 'Tükendi') : ''],
        ['Fiyat', formatPrice(p.price)],
        ['Kargo', "Ücretsiz; 17:00'ye kadar verilen siparişlerde aynı gün"]
    ].filter(([, value]) => value);
    return `<table class="sp-specs"><caption class="visually-hidden">${esc(p.name)} özellikleri</caption><tbody>${rows
        .map(([key, value]) => `<tr><th scope="row">${esc(key)}</th><td>${esc(value)}</td></tr>`).join('')}</tbody></table>`;
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
    const titleName = SEO_TITLES[p.id]?.title || p.name;
    const metaTitle = [
        `${titleName} – ${priceText} | Nokta Ayakkabıcılık`,
        `${titleName} | Nokta Ayakkabıcılık`,
        `${titleName} | Nokta`
    ].find((candidate) => candidate.length <= 62) || `${titleName} | Nokta`;
    const metaDescription = truncate(`${productPitch(p)}${p.sizes ? `, ${p.sizes} numara` : ''}: ${priceText}. Ücretsiz kargo, 17:00'ye kadar siparişte aynı gün kargoda. İade ve değişim garantisi.`, 158);
    const inStockSizes = p.sizeStock ? p.sizeStock.filter((v) => v.stock > 0).map((v) => v.size) : null;
    const soldOut = p.stock === 0 || (inStockSizes && p.sizeStock.length > 0 && inStockSizes.length === 0);
    const family = familyOf.get(p);
    const siblings = family ? family.members.filter((m) => m !== p && m.name !== p.name) : [];

    const audience = p.mainCategory?.audience || (/unisex/.test(p.t) ? 'unisex' : isKids(p) ? null : null);
    // Merchant feed ile aynı marka: Shic koleksiyonu "Nokta Shic", diğerleri mağazanın kendi markası.
    const brand = isHeel(p) ? 'Nokta Shic' : 'Nokta Ayakkabıcılık';
    const productSchema = {
        '@context': 'https://schema.org',
        '@type': 'Product',
        '@id': `${pageUrl}#product`,
        name: p.name,
        description,
        image: p.images,
        sku: String(p.id),
        mpn: `NK-${p.id}`,
        url: pageUrl,
        category: isHeel(p) ? 'Ayakkabı > Kadın > Topuklu Ayakkabı' : isWomenBoot(p) ? 'Ayakkabı > Kadın > Bot ve Çizme' : isKids(p) ? 'Ayakkabı > Çocuk' : 'Ayakkabı > Erkek',
        brand: { '@type': 'Brand', name: brand },
        ...(color ? { color: capFirst(color) } : {}),
        ...(materials.length ? { material: materials.map(capFirst).join(', ') } : {}),
        ...(audience ? { audience: { '@type': 'PeopleAudience', suggestedGender: /unisex/.test(p.t) ? 'unisex' : audience } } : {}),
        offers: {
            '@type': 'Offer',
            url: pageUrl,
            priceCurrency: 'TRY',
            price: p.price.toFixed(2),
            availability: soldOut ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
            itemCondition: 'https://schema.org/NewCondition',
            seller: organizationRef,
            shippingDetails: SHIPPING_DETAILS,
            hasMerchantReturnPolicy: RETURN_POLICY
        }
    };

    // Renk seçenekleri varsa Google'ın varyant yapısı (ProductGroup + hasVariant, çok sayfalı model)
    let mainSchema = productSchema;
    if (family) {
        const { '@context': _ctx, ...variant } = productSchema;
        mainSchema = {
            '@context': 'https://schema.org',
            '@type': 'ProductGroup',
            '@id': `${SITE}/#grup-${family.slug}`,
            name: family.name,
            productGroupID: family.slug,
            description: `${family.name} modelinin ${family.members.map((m) => productFacts(m).color).join(', ')} renk seçenekleri. ${description}`,
            url: pageUrl,
            variesBy: ['https://schema.org/color'],
            brand: { '@type': 'Brand', name: brand },
            hasVariant: [
                { ...variant, inProductGroupWithID: family.slug },
                ...family.members.filter((m) => m !== p).map((m) => ({ '@type': 'Product', url: `${SITE}${m.url}`, name: m.name, color: capFirst(productFacts(m).color) }))
            ]
        };
    }

    const related = pageProducts
        .filter((other) => other !== p && !siblings.includes(other) && p.mainCategory && other.mainCategory === p.mainCategory)
        .sort((a, b) => {
            const shared = (x) => x.collections.filter((c) => p.collections.includes(c)).length;
            return shared(b) - shared(a) || Math.abs(a.price - p.price) - Math.abs(b.price - p.price);
        })
        .slice(0, 8);

    const small = (src) => src.replace('/pictures_large/', '/pictures_small/');
    const gallery = p.images.length > 1
        ? `<div class="sp-thumbs" role="list">${p.images.map((src, i) => `<button type="button" role="listitem" class="sp-thumb${i === 0 ? ' is-active' : ''}" data-src="${esc(src)}" data-srcset="${esc(shopierSrcset(src))}" aria-label="${i + 1}. görseli göster"><img src="${esc(small(src))}" alt="" loading="lazy" width="80" height="80"></button>`).join('')}</div>`
        : '';
    const mainSrcset = shopierSrcset(p.images[0]);
    const variantsBlock = siblings.length ? `<section class="sp-variants" aria-labelledby="renkler">
  <h2 id="renkler">Bu modelin diğer renkleri</h2>
  <ul>${siblings.map((m) => {
        const mc = productFacts(m).color;
        return `<li><a href="${m.url}"><img src="${esc(small(m.images[0]))}" alt="${esc(m.name)}" width="64" height="64" loading="lazy"><span>${esc(mc ? capFirst(mc) : m.name)}</span><small>${formatPrice(m.price)}</small></a></li>`;
    }).join('')}</ul>
</section>` : '';

    const body = `<div class="sp-wrap">
${crumbs.html}
<article class="sp-product" data-product-id="${esc(p.shopierId)}" data-product-name="${esc(p.name)}" data-product-price="${p.price}">
  <div class="sp-gallery">
    <div class="sp-main-img"><img id="sp-main-img" src="${esc(p.images[0])}"${mainSrcset ? ` srcset="${esc(mainSrcset)}" sizes="${MAIN_SIZES}"` : ''} alt="${esc(p.name)}${color ? ` – ${color} renk` : ''}" width="900" height="900" fetchpriority="high" decoding="async"></div>
    ${gallery}
  </div>
  <div class="sp-info">
    ${p.mainCategory ? `<a class="sp-eyebrow" href="${p.mainCategory.url}">${esc(p.mainCategory.name)}</a>` : ''}
    <h1>${esc(SEO_TITLES[p.id]?.h1 || p.name)}</h1>
    <p class="sp-price">${priceText}</p>
    ${p.sizeStock && p.sizeStock.length
        ? `<div class="sp-size-list"><span>${soldOut ? 'Şu an stokta numara yok' : 'Stoktaki numaralar'}</span><ul>${p.sizeStock.map((v) => `<li${v.stock > 0 ? '' : ' class="is-out" title="Tükendi"'}>${esc(v.size)}</li>`).join('')}</ul></div>`
        : p.sizes ? `<p class="sp-sizes"><span>Numara aralığı</span><strong>${esc(p.sizes)}</strong></p>` : ''}
    <p class="buy-trust"><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="17.5" r="1.6"/><circle cx="17.5" cy="17.5" r="1.6"/></svg>Ücretsiz kargo</span><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h11a5 5 0 0 1 0 10H8"/><path d="M8 5 4 9l4 4"/></svg>14 gün iade</span><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>Güvenli ödeme</span></p>
    <a class="sp-buy" href="${esc(p.shopierUrl)}" rel="noopener" data-shopier="${esc(p.shopierId)}">Sepete Ekle</a>
    <a class="sp-ask" href="${INSTAGRAM}" target="_blank" rel="noopener noreferrer">Numara veya stok sorusu için Instagram'dan yazın</a>
    ${variantsBlock}
    ${trustList}
    <section class="sp-desc" aria-labelledby="urun-hakkinda">
      <h2 id="urun-hakkinda">Ürün hakkında</h2>
      <p>${esc(description)}</p>
      <h2>Ürün özellikleri</h2>
      ${specsTable(p)}
      ${heelHeight(p) && !heelHeight(p).exact ? `<p class="sp-note">Topuk boyu, modelin topuk tipine göre verilen yaklaşık bir aralıktır. Kesin ölçü için Instagram'dan model adıyla sorabilirsiniz.</p>` : ''}
      <h2>Nasıl kombinlenir?</h2>
      <p>${esc(stylingTip(p))}</p>
      <h2>Kargo, iade ve değişim</h2>
      <p>Tüm siparişler ücretsiz kargo ile gönderilir. Saat 17:00'ye kadar verilen siparişler aynı gün, sonrakiler genellikle ertesi gün kargoya teslim edilir. Ödeme Shopier'in güvenli altyapısıyla yapılır; numara uymazsa <a href="/bilgilendirme.html#iade">iade ve değişim</a> için Instagram'dan bize yazabilirsiniz.</p>
      ${p.collections.length ? `<p class="sp-chips">${p.collections.map((c) => `<a href="${c.url}">${esc(c.name)}</a>`).join('')}</p>` : ''}
    </section>
  </div>
</article>
${related.length ? `<section class="sp-related" aria-labelledby="benzer"><h2 id="benzer">Benzer modeller</h2><ul class="sp-grid">${related.map((r) => productCard(r)).join('')}</ul></section>` : ''}
</div>
${gallery ? `<script>
document.addEventListener('click',function(e){var b=e.target.closest('.sp-thumb');if(!b)return;var m=document.getElementById('sp-main-img');m.srcset=b.getAttribute('data-srcset')||'';m.src=b.getAttribute('data-src');document.querySelectorAll('.sp-thumb').forEach(function(x){x.classList.toggle('is-active',x===b);});});
</script>` : ''}`;

    return layout({
        title: metaTitle,
        description: metaDescription,
        canonical: pageUrl,
        ogType: 'product',
        ogImage: p.images[0],
        ogImageAlt: p.name,
        schema: [mainSchema, crumbs.schema],
        body,
        preloadImage: p.images[0],
        preloadSrcset: mainSrcset,
        preloadSizes: MAIN_SIZES
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
rmSync(join(OUT, 'rehber'), { recursive: true, force: true });

buildFamilies();
for (const category of activeCategories) write(`kategori/${category.slug}/index.html`, renderCategory(category));
for (const p of pageProducts) write(`urun/${p.slug}/index.html`, renderProduct(p));
for (const g of GUIDES) write(`rehber/${g.slug}/index.html`, renderGuide(g));

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
        ...GUIDES.map((g) => urlEntry(`${SITE}${g.url}`)),
        urlEntry(`${SITE}/bilgilendirme.html`)
    ].join('\n')}
</urlset>
`;
write('sitemap.xml', sitemap);

// Google Merchant Center ürün dosyası (ücretsiz listeler). Merchant Center bu adresi her gün
// "planlanmış getirme" ile okur: https://www.noktaayakkabicilik.com/merchant-feed.xml
// Yalnızca ürün sayfası olan (başka marka adı taşımayan) ürünler girer; her numara ayrı satırdır.
{
    const variantSizes = (p) => {
        if (p.sizeStock && p.sizeStock.length) return p.sizeStock.map((v) => ({ size: v.size, inStock: v.stock > 0 }));
        const nums = String(p.sizes || '').split('-').map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
        const list = nums.length === 2 && nums[1] > nums[0] && nums[1] - nums[0] <= 15
            ? Array.from({ length: nums[1] - nums[0] + 1 }, (_, i) => nums[0] + i)
            : nums;
        return list.map((n) => ({ size: String(n), inStock: p.stock !== 0 }));
    };
    const tag = (name, value) => (value === undefined || value === null || value === '' ? '' : `\n      <g:${name}>${esc(value)}</g:${name}>`);
    const items = [];
    for (const p of pageProducts) {
        const a = productAttributes(p);
        const gender = /unisex/.test(p.t) || isKids(p) ? 'unisex' : p.mainCategory?.audience === 'male' ? 'male' : 'female';
        const common = [
            tag('title', p.name),
            tag('description', productDescription(p)),
            tag('link', `${SITE}${p.url}`),
            tag('image_link', p.images[0]),
            ...p.images.slice(1, 11).map((src) => tag('additional_image_link', src)),
            tag('price', `${p.price.toFixed(2)} TRY`),
            tag('condition', 'new'),
            tag('brand', isHeel(p) ? 'Nokta Shic' : 'Nokta Ayakkabıcılık'),
            tag('identifier_exists', 'no'),
            tag('google_product_category', '187'),
            tag('product_type', isHeel(p) ? 'Ayakkabı > Kadın > Topuklu Ayakkabı' : isWomenBoot(p) ? 'Ayakkabı > Kadın > Bot ve Çizme' : isKids(p) ? 'Ayakkabı > Çocuk' : 'Ayakkabı > Erkek'),
            tag('gender', gender),
            tag('age_group', isKids(p) ? 'kids' : 'adult'),
            tag('color', a.color ? capFirst(a.color) : ''),
            tag('material', a.materials.map(capFirst).join('/')),
            `\n      <g:shipping><g:country>TR</g:country><g:price>0.00 TRY</g:price></g:shipping>`
        ].join('');
        const sizes = variantSizes(p);
        if (!sizes.length) {
            items.push(`    <item>${tag('id', `NK-${p.id}`)}${common}${tag('availability', p.stock === 0 ? 'out_of_stock' : 'in_stock')}\n    </item>`);
            continue;
        }
        for (const v of sizes) {
            items.push(`    <item>${tag('id', `NK-${p.id}-${v.size}`)}${tag('item_group_id', `NK-${p.id}`)}${common}${tag('size', v.size)}${tag('size_system', 'EU')}${tag('availability', v.inStock ? 'in_stock' : 'out_of_stock')}\n    </item>`);
        }
    }
    write('merchant-feed.xml', `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Nokta Ayakkabıcılık</title>
    <link>${SITE}/</link>
    <description>Nokta Ayakkabıcılık ürün listesi</description>
${items.join('\n')}
  </channel>
</rss>
`);
    console.log(`  merchant-feed.xml: ${items.length} satır (${pageProducts.length} ürün)`);
}

// Ana sayfadaki ürün kartlarının başlığı, ürün sayfası olan ürünlerde o sayfaya bağlanır.
{
    const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const map = Object.fromEntries(pageProducts.map((p) => [String(p.id), p.url]));
    const block = /(<script type="application\/json" id="seo-product-pages">)[\s\S]*?(<\/script>)/;
    if (block.test(indexHtml)) {
        const json = JSON.stringify(map).replace(/</g, '\\u003c');
        write('index.html', indexHtml.replace(block, (_, open, close) => `${open}${json}${close}`));
    } else {
        console.warn('Uyarı: index.html içinde seo-product-pages bloğu bulunamadı, ürün bağlantıları güncellenmedi.');
    }
}

console.log(`SEO sayfaları üretildi → ${OUT}`);
console.log(`  Kategori sayfası: ${activeCategories.length} (${activeCategories.map((c) => `${c.slug}:${c.items.length}`).join(', ')})`);
console.log(`  Ürün sayfası:     ${pageProducts.length} / ${products.length} ürün (marka adı geçen ${products.length - pageProducts.length} ürün atlandı)`);
console.log(`  Rehber yazısı:    ${GUIDES.length}`);
console.log(`  sitemap.xml:      ${2 + activeCategories.length + pageProducts.length + GUIDES.length + 1} URL`);
