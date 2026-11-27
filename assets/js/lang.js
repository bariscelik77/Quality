/*
  Site-wide EN/TR language switch for the sub-pages.
  The home page (index.html) has its own switch; both share the saved "lang" setting.

  How a page uses it:
  - Short text:   <h1 data-i18n="key">English</h1>  +  window.I18N_TR = { key: 'Türkçe' }
  - Attributes:   data-i18n-attr="aria-label:key"   (several: "title:k1;aria-label:k2")
  - Long blocks:  <div data-lang="en">...</div><div data-lang="tr">...</div>  (only one is shown;
                  ids inside the hidden block are parked so anchors still work)
  - Page title:   window.I18N_TR.__title
  - In scripts:   I18N.L('English', 'Türkçe'), I18N.lang, I18N.locale, I18N.on(function (lang) { redraw(); })
  Load this script after the page content and before the page's own script.
*/
(function () {
  var KEY = 'lang';
  var TR = window.I18N_TR || {};
  var NAV = {
    'Home': 'Ana Sayfa', 'Timeline': 'Zaman Çizelgesi', 'Dashboards': 'Gösterge Panelleri', 'Tools': 'Araçlar',
    'Knowledge': 'Bilgi Bankası', 'Cycling': 'Bisiklet', 'All guides': 'Tüm rehberler'
  };
  var lang = '';
  try { lang = localStorage.getItem(KEY) || ''; } catch (e) {}
  if (lang !== 'en' && lang !== 'tr') lang = /^tr\b/i.test(navigator.language || '') ? 'tr' : 'en';

  var listeners = [];
  var nodes = [].slice.call(document.querySelectorAll('[data-i18n]'));
  var EN = nodes.map(function (n) { return n.innerHTML; });
  var attrNodes = [].slice.call(document.querySelectorAll('[data-i18n-attr]'));
  function pairs(n) { return n.getAttribute('data-i18n-attr').split(';').map(function (p) { return p.split(':'); }); }
  var ATTR_EN = attrNodes.map(function (n) { return pairs(n).map(function (p) { return n.getAttribute(p[0]); }); });
  var navLinks = [].slice.call(document.querySelectorAll('.site-nav a, .top .nav a, footer a')).filter(function (a) { return NAV[a.textContent.trim()]; });
  var NAV_EN = navLinks.map(function (a) { return a.textContent.trim(); });
  var blocks = [].slice.call(document.querySelectorAll('[data-lang]'));
  var TITLE_EN = document.title;

  function L(en, tr) { return lang === 'tr' ? tr : en; }

  function apply(l) {
    lang = l;
    nodes.forEach(function (n, i) { var k = n.getAttribute('data-i18n'); n.innerHTML = l === 'tr' && TR[k] != null ? TR[k] : EN[i]; });
    attrNodes.forEach(function (n, i) { pairs(n).forEach(function (p, j) { n.setAttribute(p[0], l === 'tr' && TR[p[1]] != null ? TR[p[1]] : ATTR_EN[i][j]); }); });
    navLinks.forEach(function (a, i) { a.textContent = l === 'tr' ? NAV[NAV_EN[i]] : NAV_EN[i]; });
    blocks.forEach(function (b) {
      var show = b.getAttribute('data-lang') === l;
      b.hidden = !show;
      [].slice.call(b.querySelectorAll(show ? '[data-lid]' : '[id]')).forEach(function (e) {
        if (show) { e.id = e.getAttribute('data-lid'); e.removeAttribute('data-lid'); }
        else { e.setAttribute('data-lid', e.id); e.removeAttribute('id'); }
      });
    });
    document.documentElement.lang = l;
    document.title = l === 'tr' && TR.__title ? TR.__title : TITLE_EN;
    [].slice.call(document.querySelectorAll('.lang-sw button')).forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-l') === l ? 'true' : 'false'); });
    try { localStorage.setItem(KEY, l); } catch (e) {}
    window.I18N.lang = l;
    window.I18N.locale = l === 'tr' ? 'tr-TR' : 'en-GB';
    listeners.forEach(function (fn) { try { fn(l); } catch (e) { if (window.console) console.error(e); } });
  }

  /* switch in the header */
  var css = document.createElement('style');
  css.textContent =
    /* the other language's block stays hidden even when its own CSS sets display (e.g. flex) */
    '[data-lang][hidden]{display:none!important}' +
    '.lang-sw{display:inline-flex;flex:none;border:1px solid #e3e7e6;border-radius:8px;overflow:hidden;font-family:Inter,"Segoe UI",system-ui,sans-serif}' +
    '.lang-sw button{font:inherit;font-size:12.5px;font-weight:600;border:0;background:#fff;color:#6b757b;padding:5px 9px;cursor:pointer;line-height:1.2}' +
    '.lang-sw button[aria-pressed="true"]{background:#101314;color:#fff}' +
    '.lang-sw button:focus-visible{outline:2px solid #0f5c4d;outline-offset:-2px}' +
    '@media (max-width:640px){' +
      '.site-top>.wrap,.site-top>.site-wrap,.top>.wrap{flex-wrap:wrap!important;height:auto!important;min-height:52px;padding-top:10px!important;row-gap:8px}' +
      '.site-top .site-nav,.top .nav{order:3;width:100%;flex-wrap:nowrap!important;overflow-x:auto;gap:18px!important;padding-bottom:10px;scrollbar-width:none;-webkit-overflow-scrolling:touch}' +
      '.site-top .site-nav::-webkit-scrollbar,.top .nav::-webkit-scrollbar{display:none}' +
      '.site-top .site-nav a,.top .nav a{white-space:nowrap;font-size:14px!important}' +
      '.site-top .site-nav a.hide-sm,.top .nav a.hide-sm{display:inline!important}' +
      '.lang-sw{margin-left:auto}' +
    '}';
  document.head.appendChild(css);

  var header = document.querySelector('.site-top, .top');
  var hwrap = header && header.querySelector('.wrap, .site-wrap');
  // the name is shown in capitals; keep it English so Turkish casing doesn't turn "i" into "İ"
  var brand = header && header.querySelector('.site-brand, .brand');
  if (brand) brand.setAttribute('lang', 'en');
  if (hwrap) {
    var sw = document.createElement('div');
    sw.className = 'lang-sw'; sw.setAttribute('role', 'group'); sw.setAttribute('aria-label', 'Language / Dil');
    sw.innerHTML = '<button type="button" data-l="en" lang="en">EN</button><button type="button" data-l="tr" lang="tr">TR</button>';
    hwrap.appendChild(sw);
    sw.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b && b.getAttribute('data-l') !== lang) apply(b.getAttribute('data-l')); });
    // keep the active menu link in view when the menu scrolls on phones
    var active = header.querySelector('.site-nav a.active, .nav a.active');
    if (active && active.scrollIntoView) setTimeout(function () { var n = active.parentNode; if (n.scrollWidth > n.clientWidth) n.scrollLeft = active.offsetLeft - 24; }, 0);
    // expose the header height for sticky elements below it
    var setH = function () { document.documentElement.style.setProperty('--hdr', header.offsetHeight + 'px'); };
    setH();
    if (window.ResizeObserver) new ResizeObserver(setH).observe(header); else window.addEventListener('resize', setH);
  }

  window.I18N = { lang: lang, locale: lang === 'tr' ? 'tr-TR' : 'en-GB', L: L, on: function (fn) { listeners.push(fn); }, set: apply };
  apply(lang);
})();
