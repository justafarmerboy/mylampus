'use strict';

// Full-screen photo viewer. Any element with data-zoom="<image url>" opens it on tap;
// tapping anywhere (or Escape) closes it.

(() => {
  const box = document.createElement('div');
  box.className = 'lightbox hidden';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.innerHTML = '<img alt=""><button type="button" class="close-x" aria-label="✕">✕</button>';
  document.body.appendChild(box);
  const img = box.querySelector('img');

  function open(url, alt) {
    img.src = url;
    img.alt = alt || '';
    box.classList.remove('hidden');
  }

  function close() {
    box.classList.add('hidden');
    img.removeAttribute('src');
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-zoom]');
    if (el && el.dataset.zoom) {
      e.preventDefault();
      e.stopPropagation();
      open(el.dataset.zoom, el.getAttribute('alt') || el.dataset.zoomAlt);
    } else if (!box.classList.contains('hidden') && box.contains(e.target)) {
      close();
    }
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.classList.contains('hidden')) close(); });

  window.Lightbox = { open, close };
})();
