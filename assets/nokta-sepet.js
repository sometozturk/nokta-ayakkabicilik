/* Nokta Ayakkabıcılık — site sepeti
 * Ürün kartlarındaki "Sepete Ekle" butonları numara seçtirir, ürünü sepete ekler.
 * Sipariş ver: tek ürün → doğrudan Shopier ürün sayfası; birden fazla → checkout worker
 * tek ödemeli Shopier sayfası oluşturur. 3D Mağaza ile aynı sepeti (localStorage) paylaşır.
 */
(function () {
    'use strict';
    var CART_KEY = 'nokta-3d-sepet';
    var CHECKOUT_API = 'https://nokta-checkout.samet1453pro.workers.dev/checkout';
    var LAST_KEY = 'nokta-son-paket';   // önceki tek ödeme sayfasının kodu (yenisi açılınca eskisi silinir)
    function lastCode() { try { return localStorage.getItem(LAST_KEY) || ''; } catch (e) { return ''; } }
    function setLastCode(c) { try { if (c) localStorage.setItem(LAST_KEY, c); else localStorage.removeItem(LAST_KEY); } catch (e) {} }
    var MAX_QTY = 5, MAX_LINES = 8;
    // Telefonda ve Instagram/Facebook uygulama içi tarayıcısında yeni sekme açmak engelleniyor ya da kayboluyor:
    // orada ödeme sayfası aynı sekmede açılır (geri tuşuyla siteye dönülür, sepet kalır).
    var SAME_TAB = (window.matchMedia && matchMedia('(max-width: 767px), (pointer: coarse)').matches) || /Instagram|FBAN|FBAV|FB_IAB|TikTok|Line\//i.test(navigator.userAgent || '');
    function go(url) { if (SAME_TAB) window.location.href = url; else window.open(url, '_blank', 'noopener'); }
    // Shopier mağaza kampanyası: sepet 2.500 TL ve üzeriyse 400 TL indirim (Shopier ödeme sayfasında düşer)
    var PROMO = { threshold: 2500, discount: 400 };

    var products = new Map();       // site id -> ürün
    var byShopier = new Map();      // shopier id -> ürün
    var cart = [];
    var mode = 'cart';              // cart | bundle | manual | single
    var bundle = null, busy = false;

    try { cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]') || []; } catch (e) { cart = []; }
    function save() { try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) {} }
    function fmt(n) { return Number(n).toLocaleString('tr-TR') + ' TL'; }
    function shopierIdOf(url) { return String(url || '').split('?')[0].replace(/\/$/, '').split('/').pop(); }
    function cleanTitle(t) { return String(t || '').replace(/\s*\([^)]*\)\s*$/, '').trim(); }
    function track() { if (typeof fbq === 'function') { try { fbq.apply(null, arguments); } catch (e) {} } }
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

    function sizesOf(p) {
        if (Array.isArray(p.sizeStock) && p.sizeStock.length) {
            return p.sizeStock.map(function (s) { return { size: String(s.size), stock: Number(s.stock) || 0 }; })
                .sort(function (a, b) { return parseFloat(a.size) - parseFloat(b.size); });
        }
        var m = String(p.title).match(/\((\d{2})\s*-\s*(\d{2})\)/);
        var from = m ? +m[1] : 36, to = m ? +m[2] : 44, out = [];
        for (var n = from; n <= to; n++) out.push({ size: String(n), stock: 1 });
        return out;
    }

    /* ---------- stil ---------- */
    var css = '' +
        '.ns-bag{position:relative;display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 13px;border:1px solid rgba(25,23,21,.14);border-radius:999px;background:#191715;color:#f6f1e6;font-size:12px;font-weight:700;line-height:1;font-family:inherit;cursor:pointer;margin-right:8px}' +
        '.ns-bag-sp{margin:0 0 0 auto;flex:0 0 auto;background:transparent;color:inherit;border-color:currentColor}.ns-bag-sp+.sp-ig{margin-left:10px}' +
        '.ns-bag svg{width:17px;height:17px}' +
        '.ns-bag b{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#e34b35;color:#fff;font-size:10.5px;display:inline-flex;align-items:center;justify-content:center}' +
        '.ns-bag.bump{animation:nsbump .45s ease}@keyframes nsbump{40%{transform:scale(1.12)}}' +
        '@media(max-width:700px){.ns-bag .ns-bag-label{display:none}.ns-bag{padding:0 10px;margin-right:6px}}' +
        '.ns-scrim{position:fixed;inset:0;z-index:90;background:rgba(15,13,11,.45);opacity:0;pointer-events:none;transition:opacity .25s}' +
        '.ns-scrim.on{opacity:1;pointer-events:auto}' +
        '.ns-panel{position:fixed;z-index:91;top:0;right:0;height:100%;height:100dvh;width:min(410px,100%);background:#fbf8f2;color:#191715;display:flex;flex-direction:column;transform:translateX(105%);transition:transform .3s cubic-bezier(.2,.8,.2,1);box-shadow:-18px 0 40px rgba(0,0,0,.18)}' +
        '.ns-panel.on{transform:none}' +
        '.ns-sheet{top:auto;bottom:0;height:auto;max-height:88vh;left:50%;right:auto;width:min(460px,100%);border-radius:18px 18px 0 0;transform:translate(-50%,105%)}' +
        '.ns-sheet.on{transform:translate(-50%,0)}' +
        '.ns-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid rgba(25,23,21,.1)}' +
        '.ns-head h2{margin:0;font-family:Fraunces,serif;font-size:22px;font-weight:560}' +
        '.ns-x{width:34px;height:34px;border:1px solid rgba(25,23,21,.18);border-radius:50%;background:#fff;font-size:20px;line-height:1;cursor:pointer;color:#191715}' +
        '.ns-body{flex:1;overflow:auto;padding:6px 20px 12px}' +
        '.ns-foot{padding:14px 20px calc(20px + env(safe-area-inset-bottom));border-top:1px solid rgba(25,23,21,.1);display:flex;flex-direction:column;gap:9px}' +
        '.ns-empty{padding:46px 8px;text-align:center;color:#6c6259;font-size:14px;line-height:1.6}' +
        '.ns-item{display:grid;grid-template-columns:62px 1fr auto;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid rgba(25,23,21,.08)}' +
        '.ns-item img{width:62px;height:62px;object-fit:cover;border-radius:10px;background:#eee7dc}' +
        '.ns-t{font-size:13px;font-weight:700;line-height:1.3}' +
        '.ns-m{font-size:12px;color:#6c6259;margin-top:3px}' +
        '.ns-r{text-align:right;font-size:13px;font-weight:700;display:flex;flex-direction:column;align-items:flex-end;gap:6px}' +
        '.ns-qty{display:inline-flex;align-items:center;border:1px solid rgba(25,23,21,.16);border-radius:999px}' +
        '.ns-qty button{width:26px;height:24px;border:0;background:none;cursor:pointer;font-size:15px;color:#191715}' +
        '.ns-qty span{min-width:16px;text-align:center;font-size:12px}' +
        '.ns-link{font-size:11.5px;font-weight:700;color:#e34b35;text-decoration:none}' +
        '.ns-total{display:flex;justify-content:space-between;align-items:baseline;font-size:14px}' +
        '.ns-total strong{font-family:Fraunces,serif;font-size:23px}' +
        '.ns-btn{width:100%;padding:14px;border:1px solid #191715;background:#191715;color:#f6f1e6;font-size:13px;font-weight:700;line-height:1.2;font-family:inherit;cursor:pointer;border-radius:12px}' +
        '.ns-btn[disabled]{opacity:.6;cursor:wait}' +
        '.ns-btn.ghost{background:none;color:#191715;border:0;padding:6px;font-weight:600}' +
        '.ns-note{font-size:12px;line-height:1.55;color:#473e38;background:#f1ebe0;border-radius:10px;padding:10px 12px;margin:10px 0 4px}' +
        '.ns-secure{font-size:11px;color:#8b8177;text-align:center}' +
        '.ns-pick-top{display:flex;gap:14px;align-items:center;margin:12px 0 14px}' +
        '.ns-pick-top img{width:84px;height:84px;object-fit:cover;border-radius:12px;background:#eee7dc}' +
        '.ns-sizes{display:grid;grid-template-columns:repeat(auto-fill,minmax(54px,1fr));gap:8px;margin-bottom:6px}' +
        '.ns-size{padding:11px 0;border:1px solid rgba(25,23,21,.2);border-radius:10px;background:#fff;font-size:14px;font-weight:700;line-height:1;font-family:inherit;cursor:pointer;color:#191715}' +
        '.ns-size.sel{background:#191715;color:#fff;border-color:#191715}' +
        '.ns-size[disabled]{opacity:.35;text-decoration:line-through;cursor:not-allowed}' +
        '.ns-promo-bar{background:#e34b35;color:#fff;text-align:center;font-size:12.5px;font-weight:700;padding:8px 12px;letter-spacing:.01em}' +
        '.ns-promo-bar b{font-weight:800}' +
        '.ns-br{display:none}.ns-sep{opacity:.7;margin:0 6px}@media(max-width:560px){.ns-br{display:inline}.ns-sep{display:none}.ns-promo-bar{line-height:1.45}}' +
        '.ns-promo{font-size:12.5px;line-height:1.45;color:#473e38}' +
        '.ns-promo b{color:#191715}' +
        '.ns-promo.ok{color:#18552d;font-weight:700}' +
        '.ns-prog{height:6px;border-radius:99px;background:#e6ddd0;overflow:hidden;margin-top:6px}' +
        '.ns-prog i{display:block;height:100%;background:#e34b35;border-radius:99px;transition:width .3s}' +
        '.ns-disc{display:flex;justify-content:space-between;font-size:13px;color:#18552d;font-weight:700}' +
        '.ns-old{text-decoration:line-through;color:#8b8177;font-size:14px;font-family:inherit;font-weight:600;margin-right:6px}' +
        '.ns-toast{position:fixed;left:50%;bottom:24px;z-index:95;transform:translate(-50%,20px);background:#191715;color:#f6f1e6;padding:12px 18px;border-radius:999px;font-size:13px;font-weight:600;opacity:0;pointer-events:none;transition:all .25s;max-width:calc(100% - 32px);text-align:center}' +
        '.ns-toast.on{opacity:1;transform:translate(-50%,0)}';
    var style = el('style'); style.textContent = css; document.head.appendChild(style);

    /* ---------- iskelet ---------- */
    var scrim = el('div', 'ns-scrim');
    var panel = el('aside', 'ns-panel'); panel.setAttribute('aria-label', 'Sepetim'); panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML = '<div class="ns-head"><h2>Sepetim</h2><button class="ns-x" type="button" aria-label="Sepeti kapat">&times;</button></div><div class="ns-body"></div><div class="ns-foot"></div>';
    var sheet = el('aside', 'ns-panel ns-sheet'); sheet.setAttribute('aria-label', 'Numara seç'); sheet.setAttribute('aria-hidden', 'true');
    sheet.innerHTML = '<div class="ns-head"><h2>Numaranı seç</h2><button class="ns-x" type="button" aria-label="Kapat">&times;</button></div><div class="ns-body"></div><div class="ns-foot"></div>';
    var toastEl = el('div', 'ns-toast'); toastEl.setAttribute('role', 'status');
    var toastTimer;
    function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 2600); }

    var bagBtn = el('button', 'ns-bag'); bagBtn.type = 'button'; bagBtn.setAttribute('aria-label', 'Sepeti aç');
    bagBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 7h12l-1 13H7z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg><span class="ns-bag-label">Sepet</span><b>0</b>';

    function closeAll() { [panel, sheet].forEach(function (p) { p.classList.remove('on'); p.setAttribute('aria-hidden', 'true'); }); scrim.classList.remove('on'); document.documentElement.style.overflow = ''; }
    function open(p) { closeAll(); p.classList.add('on'); p.setAttribute('aria-hidden', 'false'); scrim.classList.add('on'); document.documentElement.style.overflow = 'hidden'; }
    scrim.addEventListener('click', closeAll);
    panel.querySelector('.ns-x').addEventListener('click', closeAll);
    sheet.querySelector('.ns-x').addEventListener('click', closeAll);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });
    bagBtn.addEventListener('click', function () { render(); open(panel); });

    function mount() {
        var promoBar = el('div', 'ns-promo-bar'); promoBar.innerHTML = '📦 <b>Tüm siparişlerde ücretsiz kargo</b><span class="ns-sep"> | </span><br class="ns-br">🎁 2.500 TL ve üzeri alışverişte <b>400 TL indirim</b>';
        document.body.insertBefore(promoBar, document.body.firstChild);
        document.body.appendChild(scrim); document.body.appendChild(panel); document.body.appendChild(sheet); document.body.appendChild(toastEl);
        var spHeader = document.querySelector('.sp-header-inner');
        if (spHeader) { spHeader.insertBefore(bagBtn, spHeader.querySelector('.sp-ig')); bagBtn.classList.add('ns-bag-sp'); return; }
        var host = document.querySelector('.nav-actions') || document.querySelector('.nav') || document.body;
        host.insertBefore(bagBtn, host.firstChild);
    }

    /* ---------- sepet işlemleri ---------- */
    function counts() {
        var c = 0, t = 0;
        cart.forEach(function (i) { var p = products.get(i.id); if (p) { c += i.qty; t += i.qty * Number(p.price); } });
        return { count: c, total: t };
    }
    function updateBadge() { bagBtn.querySelector('b').textContent = counts().count; }
    function changed() { mode = 'cart'; bundle = null; save(); render(); updateBadge(); }

    function add(p, size) {
        var found = cart.find(function (i) { return i.id === p.id && i.size === size; });
        if (!found && cart.length >= MAX_LINES) { toast('Sepete en fazla ' + MAX_LINES + ' farklı ürün ekleyebilirsin'); return; }
        if (found) found.qty = Math.min(MAX_QTY, found.qty + 1); else cart.push({ id: p.id, size: size, qty: 1, done: false });
        changed();
        bagBtn.classList.remove('bump'); void bagBtn.offsetWidth; bagBtn.classList.add('bump');
        track('track', 'AddToCart', { content_ids: [shopierIdOf(p.url)], content_name: p.title, content_type: 'product', value: Number(p.price), currency: 'TRY' });
    }

    /* ---------- numara seçimi ---------- */
    function openPicker(p) {
        var body = sheet.querySelector('.ns-body'), foot = sheet.querySelector('.ns-foot');
        body.innerHTML = ''; foot.innerHTML = '';
        var chosen = null;
        var top = el('div', 'ns-pick-top');
        var img = el('img'); img.src = p.image || ''; img.alt = '';
        var info = el('div'); info.appendChild(el('div', 'ns-t', cleanTitle(p.title))); info.appendChild(el('div', 'ns-m', fmt(p.price)));
        top.appendChild(img); top.appendChild(info); body.appendChild(top);
        var grid = el('div', 'ns-sizes');
        var addBtn = el('button', 'ns-btn', 'Önce numaranı seç'); addBtn.type = 'button'; addBtn.disabled = true;
        sizesOf(p).forEach(function (s) {
            var b = el('button', 'ns-size', s.size); b.type = 'button';
            if (s.stock <= 0) { b.disabled = true; b.title = 'Tükendi'; }
            b.addEventListener('click', function () {
                chosen = s.size;
                grid.querySelectorAll('.ns-size').forEach(function (x) { x.classList.toggle('sel', x === b); });
                addBtn.disabled = false; addBtn.textContent = 'Sepete ekle · ' + s.size + ' numara';
            });
            grid.appendChild(b);
        });
        body.appendChild(grid);
        body.appendChild(el('div', 'ns-m', 'İki numara arasında kaldıysan Instagram\'dan bize yazabilirsin.'));
        var inCart = counts().total;
        body.appendChild(Object.assign(el('div', 'ns-note'), { innerHTML: inCart + Number(p.price) >= PROMO.threshold
            ? '🎁 Bu ürünle sepetin 2.500 TL\'yi geçiyor: <b>400 TL indirim</b> kazanırsın.'
            : '🎁 2.500 TL ve üzeri sepette <b>400 TL indirim</b>.' }));
        addBtn.addEventListener('click', function () {
            if (!chosen) return;
            add(p, chosen);
            closeAll();
            toast('Sepete eklendi · ' + chosen + ' numara');
        });
        var goCart = el('button', 'ns-btn ghost', 'Sepete git'); goCart.type = 'button';
        goCart.addEventListener('click', function () { render(); open(panel); });
        foot.appendChild(addBtn); foot.appendChild(goCart);
        open(sheet);
    }

    /* ---------- sepet paneli ---------- */
    function render() {
        cart = cart.filter(function (i) { return products.has(i.id); });
        var body = panel.querySelector('.ns-body'), foot = panel.querySelector('.ns-foot');
        body.innerHTML = ''; foot.innerHTML = '';
        updateBadge();
        if (!cart.length) { body.innerHTML = '<div class="ns-empty">Sepetin boş.<br>Beğendiğin modelde <b>Sepete Ekle</b>\'ye bas, numaranı seç.</div>'; return; }
        if (mode === 'bundle' && bundle) {
            body.appendChild(Object.assign(el('div', 'ns-note'), { innerHTML: '<b>Ödeme sayfan hazır.</b> Tüm ürünlerin tek bir Shopier sayfasında toplandı, numaraların açıklamada yazıyor. Yeni sekmede açılmadıysa aşağıdaki butona bas.' }));
        } else if (mode === 'single') {
            body.appendChild(Object.assign(el('div', 'ns-note'), { innerHTML: 'Ürün Shopier\'de açıldı. Sayfada <b>' + (cart[0] && cart[0].size) + ' numarayı</b> seçip ödemeyi tamamlayabilirsin.' }));
        } else if (mode === 'manual') {
            body.appendChild(Object.assign(el('div', 'ns-note'), { innerHTML: 'Tek ödeme sayfası şu an oluşturulamadı. Ürünleri sırayla açıp Shopier\'de <b>aynı numarayı</b> seçerek <b>Sepete ekle</b>\'ye basabilir, en son Shopier sepetinden tek seferde ödeyebilirsin.' }));
        }
        cart.forEach(function (i, idx) {
            var p = products.get(i.id);
            var row = el('div', 'ns-item');
            var img = el('img'); img.src = p.image || ''; img.alt = ''; img.loading = 'lazy';
            var mid = el('div'); mid.appendChild(el('div', 'ns-t', cleanTitle(p.title))); mid.appendChild(el('div', 'ns-m', 'Numara: ' + i.size));
            var right = el('div', 'ns-r'); right.appendChild(el('div', null, fmt(Number(p.price) * i.qty)));
            if (mode === 'cart') {
                var q = el('div', 'ns-qty');
                var minus = el('button', null, '−'); minus.type = 'button'; minus.setAttribute('aria-label', 'Azalt');
                var plus = el('button', null, '+'); plus.type = 'button'; plus.setAttribute('aria-label', 'Arttır');
                minus.addEventListener('click', function () { if (i.qty > 1) i.qty--; else cart.splice(idx, 1); changed(); });
                plus.addEventListener('click', function () { if (i.qty < MAX_QTY) { i.qty++; changed(); } });
                q.appendChild(minus); q.appendChild(el('span', null, i.qty)); q.appendChild(plus);
                right.appendChild(q);
            } else if (mode === 'manual' || mode === 'single') {
                var a = el('a', 'ns-link', (idx + 1) + '. Shopier\'de aç'); a.href = p.url; a.target = '_blank'; a.rel = 'noopener';
                right.appendChild(a);
            }
            row.appendChild(img); row.appendChild(mid); row.appendChild(right); body.appendChild(row);
        });
        var c = counts();
        var promoOk = c.total >= PROMO.threshold;
        if (promoOk) {
            var disc = el('div', 'ns-disc'); disc.innerHTML = '<span>Sepet indirimi (2.500 TL ve üzeri)</span><span>−' + fmt(PROMO.discount) + '</span>';
            foot.appendChild(disc);
        }
        var tot = el('div', 'ns-total');
        tot.innerHTML = '<span>' + c.count + ' ürün</span><strong>' + (promoOk ? '<span class="ns-old">' + fmt(c.total) + '</span>' + fmt(c.total - PROMO.discount) : fmt(c.total)) + '</strong>';
        foot.appendChild(tot);
        if (promoOk) {
            foot.appendChild(el('div', 'ns-promo ok', '400 TL indirim Shopier ödeme sayfasında otomatik düşer.'));
        } else {
            var promo = el('div', 'ns-promo');
            promo.innerHTML = '<b>' + fmt(PROMO.threshold - c.total) + '</b> daha ekle, sepette <b>400 TL indirim</b> kazan.';
            var prog = el('div', 'ns-prog'); var bar = el('i'); bar.style.width = Math.min(100, Math.round(c.total / PROMO.threshold * 100)) + '%'; prog.appendChild(bar);
            promo.appendChild(prog);
            foot.appendChild(promo);
        }
        var btn = el('button', 'ns-btn'); btn.type = 'button';
        if (mode === 'bundle' && bundle) {
            btn.textContent = 'Ödeme sayfasını aç';
            btn.addEventListener('click', function () { go(bundle.url); });
            foot.appendChild(btn);
            foot.appendChild(doneButton());
            foot.appendChild(backButton());
        } else if (mode === 'single') {
            btn.textContent = 'Ürünü Shopier\'de aç';
            btn.addEventListener('click', function () { go(products.get(cart[0].id).url); });
            foot.appendChild(btn);
            foot.appendChild(doneButton());
            foot.appendChild(backButton());
        } else if (mode === 'manual') {
            btn.textContent = 'Shopier sepetime git ve öde';
            btn.addEventListener('click', function () { go('https://www.shopier.com/s/basket/noktaayakkabi'); });
            foot.appendChild(btn);
            foot.appendChild(doneButton());
            foot.appendChild(backButton());
        } else {
            btn.textContent = busy ? 'Ödeme sayfası hazırlanıyor…' : 'Sipariş ver';
            btn.disabled = busy;
            btn.addEventListener('click', checkout);
            foot.appendChild(btn);
            foot.appendChild(el('div', 'ns-secure', 'Ödeme Shopier\'in güvenli sayfasında yapılır'));
        }
    }
    function doneButton() {
        var b = el('button', 'ns-btn ghost', 'Siparişimi tamamladım, sepeti boşalt'); b.type = 'button';
        b.addEventListener('click', function () { cart = []; setLastCode(''); changed(); closeAll(); toast('Teşekkürler! Siparişin bize ulaşınca kargolarız.'); });
        return b;
    }
    function backButton() {
        var b = el('button', 'ns-btn ghost', '← Sepete dön'); b.type = 'button';
        b.addEventListener('click', function () { mode = 'cart'; render(); });
        return b;
    }

    /* ---------- sipariş ---------- */
    function checkout() {
        if (busy || !cart.length) return;
        var c = counts();
        track('track', 'InitiateCheckout', { content_ids: cart.map(function (i) { return shopierIdOf(products.get(i.id).url); }), content_type: 'product', num_items: c.count, value: c.total, currency: 'TRY' });
        if (cart.length === 1 && cart[0].qty === 1) {
            var p = products.get(cart[0].id);
            track('trackCustom', 'ShopierTikla', { content_ids: [shopierIdOf(p.url)], content_type: 'product', value: Number(p.price), currency: 'TRY' });
            toast('Shopier açılıyor · ' + cart[0].size + ' numarayı seçmeyi unutma');
            mode = 'single'; render();
            if (SAME_TAB) setTimeout(function () { go(p.url); }, 350); else go(p.url);
            return;
        }
        createBundle(c);
    }
    function createBundle(c) {
        busy = true; render();
        var win = null;
        if (!SAME_TAB) try {
            win = window.open('', '_blank');
            if (win) { win.opener = null; win.document.title = 'Nokta Ayakkabıcılık'; win.document.body.innerHTML = '<p style="font:16px sans-serif;padding:32px;color:#333">Shopier ödeme sayfan hazırlanıyor…</p>'; }
        } catch (e) {}
        var fallback = true;
        fetch(CHECKOUT_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ replace: lastCode(), items: cart.map(function (i) { return { shopierId: shopierIdOf(products.get(i.id).url), size: String(i.size), qty: i.qty }; }) })
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; });
        }).then(function (r) {
            if (r.res.ok && r.data.url) {
                bundle = { url: r.data.url, total: Number(r.data.total) || c.total };
                setLastCode(r.data.code);
                mode = 'bundle';
                save();
                if (win && !win.closed) win.location.href = r.data.url;
                else if (SAME_TAB) setTimeout(function () { go(r.data.url); }, 350);
                else go(r.data.url);
                track('trackCustom', 'ShopierSepet', { num_items: c.count, value: bundle.total, currency: 'TRY' });
                toast('Ödeme sayfan açıldı');
                return;
            }
            if (r.res.status === 409 || r.res.status === 400) fallback = false;
            throw new Error(r.data.error || 'Ödeme sayfası oluşturulamadı.');
        }).catch(function (err) {
            try { if (win && !win.closed) win.close(); } catch (e) {}
            if (fallback) { mode = 'manual'; toast('Tek sayfa oluşturulamadı, ürünleri sırayla açabilirsin'); }
            else { mode = 'cart'; toast(err.message); }
        }).then(function () { busy = false; save(); render(); });
    }

    /* ---------- "Sepete Ekle" butonlarını yakala ---------- */
    window.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('a.satin-al-buton, a.sp-buy');
        if (!btn || !products.size) return;
        var p = byShopier.get(shopierIdOf(btn.getAttribute('href')));
        if (!p) return;                         // bilinmeyen ürün: eski davranış (Shopier'e git)
        e.preventDefault(); e.stopPropagation();
        var modal = document.getElementById('product-modal');
        if (modal && btn.id === 'modal-shopier') { modal.hidden = true; if (window.NoktaScrollLock) window.NoktaScrollLock.unlock(); else document.body.style.overflow = ''; }
        openPicker(p);
    }, true);

    /* Ana sayfa butonlarının yazısı */
    function relabel(root) {
        (root || document).querySelectorAll('a.satin-al-buton, a.sp-buy').forEach(function (a) {
            if (a.dataset.nsLabel || !byShopier.has(shopierIdOf(a.getAttribute('href')))) return;
            a.dataset.nsLabel = '1';
            a.textContent = 'Sepete Ekle';
            a.removeAttribute('target');
        });
    }

    function init() {
        mount();
        fetch('/products.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (list) {
            (Array.isArray(list) ? list : []).forEach(function (p) {
                if (!p || !p.url || p.id == null) return;
                products.set(p.id, p); byShopier.set(shopierIdOf(p.url), p);
            });
            render(); relabel();
            new MutationObserver(function () { relabel(); }).observe(document.body, { childList: true, subtree: true });
        }).catch(function () { bagBtn.hidden = true; });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
