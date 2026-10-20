/*
 * Nokta Ayakkabıcılık – kategori ve ürün sayfaları için Meta Pixel.
 * Ana sayfadaki kodla aynı davranır: yerel test adreslerinde yüklenmez, çerez onayı
 * verilmeden olay göndermez (consent.js tercihi yönetir).
 * Ürün sayfasında ViewContent, Shopier düğmesinde ShopierTikla olayı gönderilir.
 */
(function (w, d) {
    var h = w.location.hostname || '';
    var local = w.location.protocol === 'file:' || h === '' || h === 'localhost' || h === '::1' || h === '[::1]' ||
        /\.localhost$/.test(h) || /\.local$/.test(h) || /^127\./.test(h) || /^10\./.test(h) ||
        /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
    if (local) { w.fbq = function () {}; w.fbq.loaded = true; }

    !function (f, b, e, v, n, t, s) {
        if (f.fbq) return; n = f.fbq = function () {
            n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
        };
        if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0';
        n.queue = []; t = b.createElement(e); t.async = !0;
        t.src = v; s = b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t, s);
    }(w, d, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

    var granted = false;
    try { granted = w.localStorage.getItem('nokta-consent') === 'granted'; } catch (e) {}
    if (!granted) fbq('consent', 'revoke');
    fbq('init', '1623153919352122');
    fbq('track', 'PageView');

    var product = d.querySelector('[data-product-id]');
    if (product) {
        fbq('track', 'ViewContent', {
            content_ids: [product.getAttribute('data-product-id')],
            content_type: 'product',
            content_name: product.getAttribute('data-product-name'),
            value: Number(product.getAttribute('data-product-price')) || 0,
            currency: 'TRY'
        });
    }

    d.addEventListener('click', function (e) {
        var target = e.target;
        if (!target || !target.closest) return;
        var buy = target.closest('a[data-shopier]');
        if (buy) {
            var holder = buy.closest('[data-product-id]');
            fbq('trackCustom', 'ShopierTikla', {
                content_ids: [buy.getAttribute('data-shopier')],
                content_type: 'product',
                value: holder ? Number(holder.getAttribute('data-product-price')) || 0 : 0,
                currency: 'TRY'
            });
            return;
        }
        if (target.closest('a[href*="instagram.com/nokta.ayakkabicilik"]')) fbq('trackCustom', 'InstagramTikla');
    });
})(window, document);
