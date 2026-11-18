'use strict';

// Installable app: registers the service worker and shows an "install" button everywhere
// except inside the installed app. Chrome/Edge on Android and desktop get the real install
// prompt; other browsers get instructions for their own menu.

(() => {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  const btn = document.getElementById('install');
  const tip = document.getElementById('install-tip');
  if (!btn || !tip) return;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return;

  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // In-app browsers (LINE, Facebook, Instagram, …) cannot install: open in the real browser first.
  const inApp = /\bLine\/|FBAN|FBAV|FB_IAB|Instagram|Messenger|TikTok|MicroMessenger/i.test(ua);
  const tipKey = inApp ? 'install.tipInApp'
    : isIos ? 'install.tip'
      : /android/i.test(ua) ? 'install.tipAndroid'
        : 'install.tipDesktop';

  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
  });
  window.addEventListener('appinstalled', () => {
    btn.classList.add('hidden');
    tip.classList.add('hidden');
  });
  btn.classList.remove('hidden');

  btn.addEventListener('click', async () => {
    if (deferred) {
      const prompt = deferred;
      deferred = null; // a prompt can only be shown once; afterwards fall back to instructions
      prompt.prompt();
      await prompt.userChoice.catch(() => {});
      return;
    }
    tip.innerHTML = t(tipKey);
    tip.classList.toggle('hidden');
  });
  tip.addEventListener('click', () => tip.classList.add('hidden'));
})();
