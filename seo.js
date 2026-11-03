'use strict';

// Search-engine-facing pages: a server-rendered page per truck, sitemap.xml and robots.txt.
// The map itself is drawn by JavaScript, so these pages are what Google can actually read.

const TZ = 'Asia/Bangkok';
const INDEX_DAYS = 90; // trucks opened within this many days go into the sitemap

const TEXT = {
  th: {
    titleSuffix: 'ฟู้ดทรัคบน LAMPUS',
    tagline: 'แผนที่ฟู้ดทรัคที่เปิดอยู่ตอนนี้',
    openUntil: (time) => `เปิดอยู่ตอนนี้ ✦ ถึง ${time}`,
    closed: 'ตอนนี้ปิดอยู่',
    lastOpen: (date) => `เปิดครั้งล่าสุด ${date}`,
    seeOnMap: 'ดูตำแหน่งบนแผนที่ →',
    findOthers: 'ดูฟู้ดทรัคที่เปิดอยู่ตอนนี้ →',
    menu: 'เมนู',
    food: '🍜 อาหาร',
    drinks: '🧋 เครื่องดื่ม',
    soldOut: 'หมด',
    descMenu: 'เมนู',
    descTail: 'ดูว่าเปิดอยู่ไหมและจอดอยู่ตรงไหนบน LAMPUS',
    other: 'English',
    footer: 'LAMPUS — ร้านที่เปิดอยู่จะสว่างเป็นหิ่งห้อยบนแผนที่',
  },
  en: {
    titleSuffix: 'food truck on LAMPUS',
    tagline: 'A live map of food trucks open right now',
    openUntil: (time) => `Open now ✦ until ${time}`,
    closed: 'Closed right now',
    lastOpen: (date) => `Last open ${date}`,
    seeOnMap: 'See it on the map →',
    findOthers: 'See food trucks open now →',
    menu: 'Menu',
    food: '🍜 Food',
    drinks: '🧋 Drinks',
    soldOut: 'sold out',
    descMenu: 'Menu',
    descTail: 'See if it’s open and where it’s parked on LAMPUS',
    other: 'ภาษาไทย',
    footer: 'LAMPUS — open trucks glow as fireflies on the map',
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const locale = (lang) => (lang === 'en' ? 'en-US' : 'th-TH');
const price = (n, lang) => `฿${Number(n).toLocaleString(locale(lang), { maximumFractionDigits: 2 })}`;
const abs = (site, url) => (url && url.startsWith('/') ? site + url : url);

function shopUrl(site, truck, lang) {
  return `${site}/t/${truck.id}${lang === 'en' ? '?lang=en' : ''}`;
}

function description(truck, lang) {
  const tx = TEXT[lang];
  const items = (truck.items || []).slice(0, 4).map((i) => `${i.name} ${price(i.price, lang)}`).join(', ');
  return clip([truck.menu, items && `${tx.descMenu}: ${items}`, tx.descTail].filter(Boolean).join(' · '), 160);
}

function jsonLd(site, truck, lang) {
  const section = (name, list) => ({
    '@type': 'MenuSection',
    name,
    hasMenuItem: list.map((i) => ({
      '@type': 'MenuItem',
      name: i.name,
      ...(i.desc && { description: i.desc }),
      ...(i.photo && { image: abs(site, i.photo) }),
      offers: { '@type': 'Offer', price: String(i.price), priceCurrency: 'THB', ...(i.soldOut && { availability: 'https://schema.org/SoldOut' }) },
    })),
  });
  const items = truck.items || [];
  const food = items.filter((i) => i.category !== 'drink');
  const drinks = items.filter((i) => i.category === 'drink');
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FoodEstablishment',
    name: truck.name,
    description: description(truck, lang),
    url: shopUrl(site, truck, lang),
    ...(truck.photo && { image: abs(site, truck.photo) }),
    ...(items.length && {
      hasMenu: {
        '@type': 'Menu',
        hasMenuSection: [food.length && section(TEXT[lang].food, food), drinks.length && section(TEXT[lang].drinks, drinks)].filter(Boolean),
      },
    }),
  };
  // Keep "</script>" in user text from closing the tag.
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

function menuHtml(list, title, lang) {
  if (!list.length) return '';
  return `<h3>${esc(title)}</h3>${list.map((i) => `
      <div class="menu-item${i.soldOut ? ' sold-out' : ''}">
        ${i.photo ? `<img src="${esc(i.photo)}" alt="${esc(i.name)}" loading="lazy" width="56" height="56">` : ''}
        <div class="info"><div class="name">${esc(i.name)}</div>${i.desc ? `<div class="desc">${esc(i.desc)}</div>` : ''}</div>
        <div class="price" data-sold=" · ${esc(TEXT[lang].soldOut)}">${price(i.price, lang)}</div>
      </div>`).join('')}`;
}

function renderShopPage({ site, truck, lang, open, now }) {
  const tx = TEXT[lang];
  const title = `${truck.name} — ${tx.titleSuffix}`;
  const desc = description(truck, lang);
  const image = abs(site, truck.photo) || `${site}/og.png`;
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString(locale(lang), { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const fmtDate = (ts) => new Date(ts).toLocaleDateString(locale(lang), { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
  const lastOpen = truck.lastOpenedAt || truck.openedAt;
  const indexable = lastOpen && now - lastOpen < INDEX_DAYS * 864e5;
  const items = truck.items || [];
  const other = lang === 'en' ? 'th' : 'en';

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  ${indexable ? '' : '<meta name="robots" content="noindex">'}
  <link rel="canonical" href="${esc(shopUrl(site, truck, lang))}">
  <link rel="alternate" hreflang="th" href="${esc(shopUrl(site, truck, 'th'))}">
  <link rel="alternate" hreflang="en" href="${esc(shopUrl(site, truck, 'en'))}">
  <link rel="alternate" hreflang="x-default" href="${esc(shopUrl(site, truck, 'th'))}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="LAMPUS">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:image" content="${esc(image)}">
  <meta property="og:url" content="${esc(shopUrl(site, truck, lang))}">
  <meta property="og:locale" content="${lang === 'en' ? 'en_US' : 'th_TH'}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#070b14">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Prompt:wght@400;500;600&display=swap">
  <link rel="stylesheet" href="/firefly.css">
  <script type="application/ld+json">${jsonLd(site, truck, lang)}</script>
</head>
<body>
  <main class="owner shop-page" style="--c:${esc(truck.color)}">
    <div class="owner-top">
      <a href="/${lang === 'en' ? '?lang=en' : ''}"><b>✦ LAMPUS</b></a>
      <a class="install-link" href="${esc(shopUrl('', truck, other))}" hreflang="${other}">${esc(tx.other)}</a>
    </div>
    ${truck.photo ? `<img class="shop-cover" src="${esc(truck.photo)}" alt="${esc(truck.name)}">` : ''}
    <h1>${esc(truck.name)}</h1>
    ${truck.menu ? `<p class="sub">${esc(truck.menu)}</p>` : ''}
    <div class="card shop-status${open ? ' on' : ''}">
      <div class="status${open ? ' on' : ''}">
        <div class="dot"></div>
        <div>
          <div class="big">${esc(open ? tx.openUntil(fmtTime(truck.openUntil)) : tx.closed)}</div>
          ${!open && lastOpen ? `<div class="small">${esc(tx.lastOpen(fmtDate(lastOpen)))}</div>` : ''}
        </div>
      </div>
      <a class="btn" href="/?${lang === 'en' ? 'lang=en&amp;' : ''}truck=${esc(truck.id)}">${esc(open ? tx.seeOnMap : tx.findOthers)}</a>
    </div>
    ${items.length ? `<section class="card shop-menu">
      <h2>${esc(tx.menu)}</h2>
      ${menuHtml(items.filter((i) => i.category !== 'drink'), tx.food, lang)}
      ${menuHtml(items.filter((i) => i.category === 'drink'), tx.drinks, lang)}
    </section>` : ''}
    <p class="sub shop-foot"><a href="/${lang === 'en' ? '?lang=en' : ''}">${esc(tx.footer)}</a></p>
  </main>
</body>
</html>`;
}

function sitemap({ site, trucks, now }) {
  const entry = (path, lastmod) => {
    const th = `${site}${path}`;
    const en = `${site}${path}${path.includes('?') ? '&' : '?'}lang=en`;
    return ['th', 'en'].map((lang) => `  <url>
    <loc>${esc(lang === 'en' ? en : th)}</loc>${lastmod ? `\n    <lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ''}
    <xhtml:link rel="alternate" hreflang="th" href="${esc(th)}"/>
    <xhtml:link rel="alternate" hreflang="en" href="${esc(en)}"/>
  </url>`).join('\n');
  };
  const shops = trucks
    .filter((t) => (t.lastOpenedAt || t.openedAt) && now - (t.lastOpenedAt || t.openedAt) < INDEX_DAYS * 864e5)
    .map((t) => entry(`/t/${t.id}`, t.lastOpenedAt || t.openedAt));
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${[entry('/'), ...shops].join('\n')}
</urlset>
`;
}

function robots({ site }) {
  return `User-agent: *
Disallow: /admin
Disallow: /api/

Sitemap: ${site}/sitemap.xml
`;
}

module.exports = { renderShopPage, sitemap, robots };
