/*
 * Nokta Ayakkabıcılık – çerez / reklam ölçümü tercihi
 * Meta Pixel varsayılan olarak kapalıdır (sayfadaki pixel kodu fbq('consent','revoke') ile başlar).
 * Ziyaretçi "Kabul et" derse fbq('consent','grant') çağrılır; tercih bu tarayıcıda saklanır.
 * Tercih, sayfa altındaki "Çerez tercihleri" bağlantısıyla (data-consent-open) değiştirilebilir.
 */
(function () {
    'use strict';
    var KEY = 'nokta-consent';

    function read() {
        try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
    }
    function write(value) {
        try { window.localStorage.setItem(KEY, value); } catch (e) { /* özel pencere vb. */ }
    }
    function applyPixel(value) {
        if (typeof window.fbq === 'function') {
            window.fbq('consent', value === 'granted' ? 'grant' : 'revoke');
        }
    }

    var css = '' +
        '.nk-consent{position:fixed;left:12px;right:12px;bottom:12px;z-index:200;max-width:560px;margin:0 auto;' +
        'padding:16px 18px;border-radius:14px;background:#151515;color:#f5efe4;border:1px solid rgba(245,239,228,.18);' +
        'box-shadow:0 18px 44px rgba(0,0,0,.35);font:14px/1.5 "DM Sans",system-ui,sans-serif;}' +
        '.nk-consent[hidden]{display:none;}' +
        '.nk-consent p{margin:0 0 12px;color:#e8e1d4;}' +
        '.nk-consent a{color:#fff;text-decoration:underline;text-underline-offset:2px;}' +
        '.nk-consent-actions{display:flex;gap:10px;}' +
        '.nk-consent button{flex:1 1 0;min-height:44px;padding:10px 14px;border-radius:10px;font:600 14px "DM Sans",system-ui,sans-serif;cursor:pointer;}' +
        '.nk-consent button[data-nk="deny"]{background:transparent;color:#f5efe4;border:1px solid rgba(245,239,228,.45);}' +
        '.nk-consent button[data-nk="grant"]{background:#e34b35;color:#fff;border:1px solid #e34b35;}' +
        '.nk-consent button:focus-visible{outline:2px solid #fff;outline-offset:2px;}' +
        '.legal-link-button{background:none;border:0;padding:0;margin:0;font:inherit;font-size:11px;color:var(--muted,#8a8073);cursor:pointer;text-decoration:none;}' +
        '.legal-link-button:hover{color:var(--accent,#c1291f);}' +
        '@media (min-width:700px){.nk-consent{left:20px;right:auto;bottom:20px;margin:0;}}';

    var box = null;
    var styled = false;

    // Alt bilgideki "Çerez tercihleri" düğmesinin stili, banner hiç açılmasa bile gerekir.
    function ensureStyle() {
        if (styled) return;
        styled = true;
        var style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }

    function build() {
        if (box) return box;
        ensureStyle();

        box = document.createElement('div');
        box.className = 'nk-consent';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-label', 'Çerez tercihleri');
        box.hidden = true;
        box.innerHTML =
            '<p>Reklam ölçümü için Meta Pixel (çerez) kullanıyoruz. Kabul ederseniz ürün ilgisi ve reklam performansı ölçülür; ' +
            'reddederseniz bu ölçüm yapılmaz. <a href="bilgilendirme.html#kvkk">Ayrıntılar</a></p>' +
            '<div class="nk-consent-actions">' +
            '<button type="button" data-nk="deny">Reddet</button>' +
            '<button type="button" data-nk="grant">Kabul et</button>' +
            '</div>';
        box.addEventListener('click', function (event) {
            var button = event.target.closest('button[data-nk]');
            if (!button) return;
            var value = button.getAttribute('data-nk') === 'grant' ? 'granted' : 'denied';
            write(value);
            applyPixel(value);
            box.hidden = true;
        });
        document.body.appendChild(box);
        return box;
    }

    function open() {
        build().hidden = false;
    }

    window.NoktaConsent = { open: open, get: read };

    document.addEventListener('click', function (event) {
        var trigger = event.target.closest && event.target.closest('[data-consent-open]');
        if (!trigger) return;
        event.preventDefault();
        open();
    });

    function start() {
        ensureStyle();
        var stored = read();
        if (stored === 'granted' || stored === 'denied') {
            applyPixel(stored);
            return;
        }
        // İlk ziyaret: açılış perdesi bittikten sonra göster.
        var delay = document.querySelector('.opening-screen') ? 2900 : 600;
        window.setTimeout(open, delay);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
