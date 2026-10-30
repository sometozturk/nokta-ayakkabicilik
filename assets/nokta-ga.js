/*
 * Nokta Ayakkabıcılık – Google Analytics 4 (G-N8YSLF1FX2)
 * - Yerel test adreslerinde yüklenmez.
 * - Ziyaretçi alt bilgideki "Çerez tercihleri"nden reddettiyse yüklenmez (consent.js ile aynı tercih).
 * - Shopier'e giden "Satın Al" tıklamaları ve Instagram tıklamaları olay olarak gönderilir.
 */
(function (w, d) {
    'use strict';
    var ID = 'G-N8YSLF1FX2';
    var h = w.location.hostname || '';
    var local = w.location.protocol === 'file:' || h === '' || h === 'localhost' || h === '::1' || h === '[::1]' ||
        /\.localhost$/.test(h) || /\.local$/.test(h) || /^127\./.test(h) || /^10\./.test(h) ||
        /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
    var denied = false;
    try { denied = w.localStorage.getItem('nokta-consent') === 'denied'; } catch (e) {}
    if (local || denied || w.__noktaGA) return;
    w.__noktaGA = true;

    w.dataLayer = w.dataLayer || [];
    function gtag() { w.dataLayer.push(arguments); }
    w.gtag = w.gtag || gtag;
    w.gtag('js', new Date());
    w.gtag('config', ID);

    var s = d.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID;
    (d.head || d.documentElement).appendChild(s);

    d.addEventListener('click', function (event) {
        var a = event.target && event.target.closest && event.target.closest('a[href]');
        if (!a) return;
        var href = a.href || '';
        if (/shopier\.com/i.test(href)) {
            w.gtag('event', 'satin_al_tikla', {
                link_url: href,
                link_text: (a.innerText || '').trim().slice(0, 60),
                page_path: w.location.pathname
            });
        } else if (/instagram\.com/i.test(href)) {
            w.gtag('event', 'instagram_tikla', { link_url: href, page_path: w.location.pathname });
        }
    }, true);
})(window, document);
