/* global fireflies, openSheet, closeSheet, map, sheet, sheetId */
'use strict';

// Customer's own things, kept on this device: saved (favorite) shops and chats with shops.
// Uses the map page's globals (fireflies, openSheet, …) at click time.

window.Mine = (() => {
  const FAVS = 'lampus.favs';     // { truckId: { name, color } }
  const CHATS = 'lampus.chats';   // { chatId: { token, truckId, truckName } }
  const NAME = 'lampus.guestName';

  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* memory only */ } };

  const favs = load(FAVS, {});
  const chats = load(CHATS, {});
  let summaries = {};             // chatId -> summary from the server
  let tab = 'favs';
  let thread = null;              // open ChatView

  const btn = document.createElement('button');
  btn.className = 'btn-round mine-btn';
  btn.innerHTML = '⭐<span class="badge hidden"></span>';
  btn.setAttribute('aria-label', t('mine.button'));
  btn.title = t('mine.button');
  document.body.appendChild(btn);

  const panel = document.createElement('aside');
  panel.className = 'mine-panel';
  panel.setAttribute('aria-hidden', 'true');
  document.body.appendChild(panel);

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const isFav = (id) => Boolean(favs[id]);

  function toggleFav(truck) {
    if (favs[truck.id]) delete favs[truck.id];
    else favs[truck.id] = { name: truck.name, color: truck.color };
    store(FAVS, favs);
    markFireflies();
    if (panel.classList.contains('open') && !thread) renderPanel();
  }

  // Saved shops get a star on their map label.
  function markFireflies() {
    for (const ff of fireflies.values()) {
      ff.el.classList.toggle('fav', isFav(ff.truck.id));
      if (favs[ff.truck.id] && favs[ff.truck.id].name !== ff.truck.name) {
        favs[ff.truck.id] = { name: ff.truck.name, color: ff.truck.color };
        store(FAVS, favs);
      }
    }
  }

  const unreadTotal = () => Object.values(summaries).reduce((n, s) => n + (s.unread || 0), 0);

  function updateBadge() {
    const n = unreadTotal();
    const badge = btn.querySelector('.badge');
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.classList.toggle('hidden', !n);
  }

  async function refreshChats() {
    const list = Object.entries(chats).map(([id, c]) => ({ id, token: c.token }));
    if (!list.length) return;
    try {
      const res = await fetch('/api/chats-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chats: list.slice(-50) }),
      });
      if (!res.ok) return;
      summaries = {};
      for (const s of (await res.json()).chats) {
        if (s.gone) {
          delete chats[s.id];
        } else {
          summaries[s.id] = s;
          if (s.truckName) chats[s.id].truckName = s.truckName;
        }
      }
      store(CHATS, chats);
      updateBadge();
      if (panel.classList.contains('open') && !thread && tab === 'chats') renderPanel();
    } catch { /* offline: try again later */ }
  }

  function openPanel(which) {
    if (which) tab = which;
    closeSheet();
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    renderPanel();
    refreshChats();
  }

  function closePanel() {
    thread?.stop();
    thread = null;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
  }

  function renderPanel() {
    thread?.stop();
    thread = null;
    const favRows = Object.entries(favs).map(([id, f]) => {
      const live = fireflies.get(id);
      const open = live && !live.dying;
      return `<div class="mine-row" style="--c:${f.color}">
        <button type="button" class="mine-main" data-go="${id}" ${open ? '' : 'disabled'}>
          <span class="dot${open ? ' on' : ''}"></span>
          <span><b>${escapeHtml(open ? live.truck.name : f.name)}</b><small>${t(open ? 'mine.openNow' : 'mine.closed')}</small></span>
        </button>
        <button type="button" class="mine-side" data-unfav="${id}">${t('mine.remove')}</button>
      </div>`;
    }).join('');
    const chatRows = Object.entries(chats)
      .sort(([a], [b]) => (summaries[b]?.lastAt || 0) - (summaries[a]?.lastAt || 0))
      .map(([id, c]) => {
        const s = summaries[id];
        return `<div class="mine-row">
          <button type="button" class="mine-main" data-chat-id="${id}">
            <span class="dot${s?.unread ? ' unread' : ''}"></span>
            <span><b>${escapeHtml(c.truckName)}</b><small>${escapeHtml(s?.last?.text || t('chat.empty'))}</small></span>
          </button>
          ${s?.unread ? `<span class="count">${s.unread}</span>` : ''}
        </div>`;
      }).join('');
    panel.innerHTML = `
      <div class="mine-head">
        <div class="mine-tabs">
          <button type="button" data-tab="favs" aria-pressed="${tab === 'favs'}">${t('mine.favs')}</button>
          <button type="button" data-tab="chats" aria-pressed="${tab === 'chats'}">${t('mine.chats')}${unreadTotal() ? ` <b>${unreadTotal()}</b>` : ''}</button>
        </div>
        <button type="button" class="close-x" data-mine-close aria-label="${t('mine.close')}">✕</button>
      </div>
      <div class="mine-body">
        ${tab === 'favs' ? (favRows || `<p class="sub">${t('mine.noFavs')}</p>`) : (chatRows || `<p class="sub">${t('mine.noChats')}</p>`)}
      </div>`;
  }

  function showThread(chatId) {
    const c = chats[chatId];
    if (!c) return;
    tab = 'chats';
    panel.innerHTML = '<div class="mine-thread"></div>';
    thread = ChatView(panel.firstElementChild, {
      id: chatId,
      token: c.token,
      role: 'guest',
      title: t('chat.with', { name: c.truckName }),
      onBack: () => { refreshChats(); renderPanel(); },
      onGone: () => { delete chats[chatId]; store(CHATS, chats); },
    });
    if (summaries[chatId]) summaries[chatId].unread = 0;
    updateBadge();
  }

  // Start (or reopen) a chat with a truck from its sheet.
  async function chatWith(truck) {
    const existing = Object.entries(chats).find(([, c]) => c.truckId === truck.id);
    if (existing) {
      openPanel('chats');
      showThread(existing[0]);
      return;
    }
    let guestName = localStorage.getItem(NAME);
    if (guestName == null) {
      guestName = (prompt(t('chat.askName')) || '').trim().slice(0, 30);
      store(NAME, guestName);
    }
    const res = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ truckId: truck.id, guestName }),
    });
    if (!res.ok) {
      alert(t(res.status === 429 ? 'chat.tooMany' : 'chat.failed'));
      return;
    }
    const data = await res.json();
    chats[data.id] = { token: data.token, truckId: truck.id, truckName: data.truckName };
    store(CHATS, chats);
    openPanel('chats');
    showThread(data.id);
  }

  btn.addEventListener('click', () => (panel.classList.contains('open') ? closePanel() : openPanel(unreadTotal() ? 'chats' : 'favs')));

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-fav],[data-chat],[data-tab],[data-mine-close],[data-go],[data-unfav],[data-chat-id]');
    if (!el) return;
    const d = el.dataset;
    if (d.fav) {
      const ff = fireflies.get(d.fav);
      if (!ff) return;
      toggleFav(ff.truck);
      el.textContent = t(isFav(d.fav) ? 'sheet.saved' : 'sheet.save');
      el.setAttribute('aria-pressed', String(isFav(d.fav)));
    } else if (d.chat) {
      const ff = fireflies.get(d.chat);
      if (ff) chatWith(ff.truck);
    } else if (d.tab) {
      tab = d.tab;
      renderPanel();
    } else if ('mineClose' in d) {
      closePanel();
    } else if (d.go) {
      const ff = fireflies.get(d.go);
      if (!ff) return;
      closePanel();
      map.flyTo(ff.target, Math.max(map.getZoom(), 16));
      openSheet(d.go);
    } else if (d.unfav) {
      delete favs[d.unfav];
      store(FAVS, favs);
      markFireflies();
      renderPanel();
    } else if (d.chatId) {
      showThread(d.chatId);
    }
  });

  setInterval(() => { if (document.visibilityState === 'visible') refreshChats(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshChats(); });
  refreshChats();

  return { isFav, markFireflies, closePanel };
})();
