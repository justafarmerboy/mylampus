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
    <p class="sub shop-foot"><a href="/${lang === 'en' ? '?lang=en' : ''}">${esc(tx.footer)}</a><br><a href="/privacy${lang === 'en' ? '?lang=en' : ''}">${lang === 'en' ? 'Privacy' : 'ความเป็นส่วนตัว'}</a></p>
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
${[entry('/'), entry('/privacy'), ...shops].join('\n')}
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

const PRIVACY = {
  th: {
    title: 'นโยบายความเป็นส่วนตัว — LAMPUS',
    updated: 'ปรับปรุงล่าสุด 3 พฤศจิกายน 2026',
    intro: 'LAMPUS เป็นแผนที่ฟู้ดทรัคที่เปิดอยู่ตอนนี้ หน้านี้อธิบายว่าเราเก็บข้อมูลอะไร ใช้ทำอะไร และเก็บไว้นานแค่ไหน เราไม่มีโฆษณา ไม่ขายข้อมูล และไม่ใช้เครื่องมือติดตามพฤติกรรม',
    sections: [
      ['ลูกค้า (ผู้ดูแผนที่)', [
        'ไม่ต้องสมัครสมาชิก',
        'ปุ่ม “ตำแหน่งของฉัน” ใช้ตำแหน่งของคุณบนเครื่องเท่านั้น ไม่ได้ส่งมาที่เซิร์ฟเวอร์',
        'ร้านโปรด รหัสแชท ชื่อที่ใช้แชท และภาษาที่เลือก เก็บไว้ในเบราว์เซอร์ของคุณเอง ลบได้โดยล้างข้อมูลเว็บไซต์',
        'ข้อความแชทกับร้าน และชื่อที่คุณใส่ (ถ้ามี) เก็บบนเซิร์ฟเวอร์เพื่อส่งให้ร้าน ในแอปเห็นได้เฉพาะคุณและร้านนั้น ผู้ดูแลระบบเข้าถึงได้ผ่านไฟล์สำรองข้อมูลเพื่อดูแลระบบและจัดการการใช้งานที่ไม่เหมาะสมเท่านั้น',
      ]],
      ['เจ้าของร้าน', [
        'ชื่อร้าน คำอธิบาย เมนู ราคา รูป และสีหิ่งห้อย แสดงต่อสาธารณะบนแผนที่และหน้าร้าน',
        'ตำแหน่ง GPS ส่งเฉพาะตอนเปิดร้านอยู่ และแสดงต่อสาธารณะแบบสดระหว่างเปิดร้าน เราไม่เก็บประวัติเส้นทาง เก็บเฉพาะตำแหน่งล่าสุด และไม่แสดงตำแหน่งเมื่อปิดร้าน',
        'รหัสร้านเก็บในเบราว์เซอร์ของคุณ เซิร์ฟเวอร์เก็บเพียงค่าแฮชของรหัส',
      ]],
      ['ความคิดเห็นถึงผู้สร้าง', [
        'ข้อความและช่องทางติดต่อที่คุณใส่ (ถ้ามี) อ่านได้เฉพาะผู้ดูแลระบบ',
      ]],
      ['ข้อมูลทางเทคนิค', [
        'ผู้ให้บริการเซิร์ฟเวอร์ (Railway) บันทึกที่อยู่ IP และชนิดเบราว์เซอร์ของคำขอเพื่อดูแลระบบ',
        'เราใช้ที่อยู่ IP ชั่วคราวในหน่วยความจำเพื่อกันสแปม',
      ]],
      ['บริการภายนอก', [
        'ภาพแผนที่โหลดจาก OpenStreetMap และฟอนต์จาก Google Fonts ผู้ให้บริการเหล่านี้จะเห็นที่อยู่ IP ของคุณตอนโหลด',
        'ปุ่ม “นำทาง” เปิด Google Maps เมื่อคุณกดเท่านั้น',
      ]],
      ['ระยะเวลาเก็บและการลบ', [
        'แชทเก็บสูงสุด 200 ข้อความต่อแชท ร้านลบแชทได้ทุกเมื่อ',
        'ข้อมูลสำรองรายวันเก็บ 14 วันแล้วลบอัตโนมัติ',
        'ต้องการลบร้านหรือข้อมูลของคุณ แจ้งผ่านปุ่ม 💬 ส่งความคิดเห็นถึงผู้สร้าง พร้อมช่องทางติดต่อกลับ',
      ]],
    ],
    back: '← กลับไปที่แผนที่',
    other: 'English',
  },
  en: {
    title: 'Privacy policy — LAMPUS',
    updated: 'Last updated 3 November 2026',
    intro: 'LAMPUS is a live map of food trucks that are open right now. This page explains what we store, why, and for how long. We have no ads, sell no data and use no behavioural tracking.',
    sections: [
      ['Customers (map visitors)', [
        'No account is needed.',
        'The “My location” button uses your location on your device only; it is never sent to our server.',
        'Saved shops, chat keys, your chat name and language choice are stored in your own browser; clearing site data removes them.',
        'Chat messages with a shop, and the name you give (if any), are stored on our server so the shop can read them. In the app only you and that shop can see them; the site administrator can access them through data backups, only to run the service and handle abuse.',
      ]],
      ['Truck owners', [
        'Shop name, description, menu, prices, photos and glow color are public on the map and the shop page.',
        'GPS location is sent only while your shop is open and is shown publicly, live, during that time. We keep no route history, only the last position, and never show it while you are closed.',
        'Your shop code is stored in your browser; the server keeps only a hash of it.',
      ]],
      ['Feedback to the creator', [
        'Your message and contact details (if any) can be read only by the site administrator.',
      ]],
      ['Technical data', [
        'Our hosting provider (Railway) logs IP addresses and browser types of requests to operate the service.',
        'IP addresses are held briefly in memory to limit spam.',
      ]],
      ['Third-party services', [
        'Map images load from OpenStreetMap and fonts from Google Fonts; these providers see your IP address when they load.',
        'The “Get directions” button opens Google Maps only when you tap it.',
      ]],
      ['Retention and deletion', [
        'Chats keep up to 200 messages; shops can delete a chat at any time.',
        'Daily backups are kept for 14 days, then deleted automatically.',
        'To have your shop or data deleted, use 💬 Send feedback to the creator and include a way to reach you.',
      ]],
    ],
    back: '← Back to the map',
    other: 'ภาษาไทย',
  },
};

function renderPrivacyPage({ site, lang }) {
  const p = PRIVACY[lang];
  const other = lang === 'en' ? 'th' : 'en';
  const url = (l) => `${site}/privacy${l === 'en' ? '?lang=en' : ''}`;
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(p.title)}</title>
  <meta name="description" content="${esc(p.intro)}">
  <link rel="canonical" href="${esc(url(lang))}">
  <link rel="alternate" hreflang="th" href="${esc(url('th'))}">
  <link rel="alternate" hreflang="en" href="${esc(url('en'))}">
  <meta name="theme-color" content="#070b14">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Prompt:wght@400;500;600&display=swap">
  <link rel="stylesheet" href="/firefly.css">
</head>
<body>
  <main class="owner shop-page privacy">
    <div class="owner-top">
      <a href="/${lang === 'en' ? '?lang=en' : ''}"><b>✦ LAMPUS</b></a>
      <a class="install-link" href="/privacy${other === 'en' ? '?lang=en' : ''}" hreflang="${other}">${esc(p.other)}</a>
    </div>
    <h1>${esc(p.title.split(' — ')[0])}</h1>
    <p class="sub">${esc(p.updated)}</p>
    <p>${esc(p.intro)}</p>
    ${p.sections.map(([h, items]) => `<section class="card"><h2>${esc(h)}</h2><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></section>`).join('\n    ')}
    <p class="shop-foot"><a href="/${lang === 'en' ? '?lang=en' : ''}">${esc(p.back)}</a></p>
  </main>
</body>
</html>`;
}

module.exports = { renderShopPage, renderPrivacyPage, sitemap, robots };
