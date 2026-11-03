'use strict';

// One chat thread, used by customers (map page) and truck owners (owner page).
// Polls for new messages every few seconds while it is on screen.

window.ChatView = function ChatView(box, { id, token, role, title, onBack, onDelete, onGone }) {
  box.innerHTML = `
    <div class="chat">
      <div class="chat-head">
        <button type="button" class="chat-back" aria-label="${t('chat.back')}">←</button>
        <b class="chat-title"></b>
        ${onDelete ? `<button type="button" class="chat-del">${t('chat.delete')}</button>` : ''}
      </div>
      <div class="chat-list" aria-live="polite"><div class="chat-empty">${t('chat.empty')}</div></div>
      <form class="chat-form">
        <textarea rows="1" maxlength="500" required placeholder="${t('chat.placeholder')}"></textarea>
        <button class="btn" type="submit">${t('chat.send')}</button>
      </form>
      <div class="msg chat-err"></div>
    </div>`;
  const $ = (s) => box.querySelector(s);
  $('.chat-title').textContent = title;
  const list = $('.chat-list');
  const input = $('textarea');
  let lastN = 0;
  let stopped = false;

  async function call(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function stamp(at) {
    const d = new Date(at);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString(I18N.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function add(messages) {
    if (!messages.length) return;
    $('.chat-empty')?.remove();
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    for (const m of messages) {
      if (m.n <= lastN) continue;
      lastN = m.n;
      const b = document.createElement('div');
      b.className = `bubble ${m.from === role ? 'mine' : 'theirs'}`;
      const text = document.createElement('div');
      text.textContent = m.text;
      const time = document.createElement('small');
      time.textContent = stamp(m.at);
      b.append(text, time);
      list.appendChild(b);
    }
    if (atBottom || messages.some((m) => m.from === role)) list.scrollTop = list.scrollHeight;
  }

  function showError(text) {
    $('.chat-err').textContent = text;
    $('.chat-err').classList.toggle('err', Boolean(text));
  }

  async function refresh() {
    if (stopped) return;
    try {
      add((await call(`/api/chats/${id}`, { since: lastN })).messages);
    } catch (err) {
      if (err.status === 404 || err.status === 403) {
        stop();
        showError(t('chat.gone'));
        input.disabled = true;
        onGone?.();
      }
    }
  }

  $('.chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const btn = $('.chat-form button');
    btn.disabled = true;
    try {
      const { message } = await call(`/api/chats/${id}/send`, { text });
      input.value = '';
      input.style.height = '';
      showError('');
      add([message]);
    } catch (err) {
      showError(t(err.status === 429 ? 'chat.tooFast' : 'chat.failed'));
    } finally {
      btn.disabled = false;
      input.focus();
    }
  });

  // Enter sends, Shift+Enter makes a new line; the box grows with its text.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('.chat-form').requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });

  $('.chat-back').addEventListener('click', () => { stop(); onBack?.(); });
  $('.chat-del')?.addEventListener('click', async () => {
    if (!confirm(t('chat.confirmDelete'))) return;
    await call(`/api/chats/${id}/delete`).catch(() => {});
    stop();
    onDelete();
  });

  const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 4000);
  function stop() {
    stopped = true;
    clearInterval(timer);
  }

  refresh();
  return { stop };
};
