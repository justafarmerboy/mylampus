'use strict';

// Installable app: registers the service worker and shows an "install" button.
// Android/desktop Chrome offer a real install prompt; iPhone needs Share › Add to Home Screen.

(() => {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  const btn = document.getElementById('install');
  if (!btn) return;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (standalone) return;

  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => btn.classList.add('hidden'));
  if (isIos) btn.classList.remove('hidden');

  btn.addEventListener('click', async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice.catch(() => {});
      deferred = null;
      btn.classList.add('hidden');
      return;
    }
    const tip = document.getElementById('install-tip');
    tip.classList.toggle('hidden');
  });
  document.getElementById('install-tip')?.addEventListener('click', (e) => e.currentTarget.classList.add('hidden'));
})();
