'use strict';

// "Send feedback to the creator" dialog, shared by the map and owner pages.
// Any element with [data-feedback] opens it.

(() => {
  const isOwner = location.pathname.startsWith('/owner');
  const dlg = document.createElement('div');
  dlg.className = 'fb-backdrop hidden';
  dlg.innerHTML = `
    <form class="fb card" role="dialog" aria-modal="true" aria-labelledby="fb-title">
      <h2 id="fb-title">${t('fb.title')}</h2>
      <p class="sub" style="margin:0">${t('fb.intro')}</p>
      <label for="fb-kind">${t('fb.kind')}</label>
      <select id="fb-kind">
        <option value="idea">${t('fb.idea')}</option>
        <option value="bug">${t('fb.bug')}</option>
        <option value="other">${t('fb.other')}</option>
      </select>
      <label for="fb-message">${t('fb.message')}</label>
      <textarea id="fb-message" maxlength="1000" required rows="5" placeholder="${t('fb.messagePh')}"></textarea>
      <label for="fb-contact">${t('fb.contact')}</label>
      <input id="fb-contact" maxlength="120" placeholder="${t('fb.contactPh')}">
      <button class="btn" type="submit">${t('fb.send')}</button>
      <button class="btn ghost" type="button" data-fb-close>${t('fb.cancel')}</button>
      <div class="msg" id="fb-msg"></div>
    </form>`;
  document.body.appendChild(dlg);
  const $ = (id) => document.getElementById(id);

  function open() {
    $('fb-msg').textContent = '';
    $('fb-msg').classList.remove('err');
    dlg.classList.remove('hidden');
    $('fb-message').focus();
  }

  function close() {
    dlg.classList.add('hidden');
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-feedback]')) open();
    else if (e.target === dlg || e.target.closest('[data-fb-close]')) close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    let truckId = null;
    try { truckId = isOwner ? JSON.parse(localStorage.getItem('mylampus.owner'))?.id : null; } catch { /* ignore */ }
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: $('fb-kind').value,
          message: $('fb-message').value,
          contact: $('fb-contact').value,
          from: isOwner ? 'owner' : 'customer',
          truckId,
        }),
      });
      if (res.status === 429) throw new Error(t('fb.tooMany'));
      if (!res.ok) throw new Error(t('fb.failed'));
      $('fb-message').value = '';
      $('fb-msg').textContent = t('fb.sent');
      setTimeout(close, 1500);
    } catch (err) {
      $('fb-msg').textContent = err.message;
      $('fb-msg').classList.add('err');
    } finally {
      btn.disabled = false;
    }
  });
})();
