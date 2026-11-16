'use strict';

// Photo cropper for the owner page. Shows the picked photo behind a frame with the exact
// shape customers will see; the owner drags to move it and pinches (or uses the slider or
// mouse wheel) to zoom. Resolves with a JPEG Blob of the framed part, or null if cancelled.

window.Cropper = (() => {
  const MAX_ZOOM = 4; // relative to the smallest zoom that still fills the frame

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(t('o.badImage')));
      img.src = URL.createObjectURL(file);
    });
  }

  async function open(file, [outW, outH]) {
    const img = await loadImage(file);
    const W = img.naturalWidth;
    const H = img.naturalHeight;

    const box = document.createElement('div');
    box.className = 'cropper';
    box.innerHTML = `
      <div class="cropper-inner">
        <h2>${t('crop.title')}</h2>
        <p class="sub">${t('crop.hint')}</p>
        <div class="cropper-frame"></div>
        <label class="cropper-zoom"><span>${t('crop.zoom')}</span><input type="range" min="0" max="1000" value="0"></label>
        <div class="cropper-actions">
          <button type="button" class="btn ghost" data-crop="cancel">${t('crop.cancel')}</button>
          <button type="button" class="btn" data-crop="use">${t('crop.use')}</button>
        </div>
      </div>`;
    document.body.appendChild(box);
    const frame = box.querySelector('.cropper-frame');
    const slider = box.querySelector('input[type=range]');
    frame.appendChild(img);

    // Frame size in CSS pixels, same shape as the output, as large as fits the screen.
    const maxW = Math.min(window.innerWidth - 32, 520);
    const maxH = window.innerHeight * 0.55;
    const k = Math.min(maxW / outW, maxH / outH);
    const FW = Math.round(outW * k);
    const FH = Math.round(outH * k);
    frame.style.width = `${FW}px`;
    frame.style.height = `${FH}px`;

    const minS = Math.max(FW / W, FH / H);
    let s = minS;
    let x = (FW - W * s) / 2;
    let y = (FH - H * s) / 2;

    function clamp() {
      x = Math.min(0, Math.max(FW - W * s, x));
      y = Math.min(0, Math.max(FH - H * s, y));
    }

    function draw() {
      clamp();
      img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    }

    // Zoom to `next`, keeping the frame point (px, py) where it is.
    function zoomTo(next, px = FW / 2, py = FH / 2) {
      next = Math.min(minS * MAX_ZOOM, Math.max(minS, next));
      x = px - ((px - x) / s) * next;
      y = py - ((py - y) / s) * next;
      s = next;
      slider.value = String(Math.round(((s / minS - 1) / (MAX_ZOOM - 1)) * 1000));
      draw();
    }

    // Dragging with one finger or the mouse, pinching with two fingers.
    const pointers = new Map();
    let pinch = null;
    frame.addEventListener('pointerdown', (e) => {
      frame.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), s };
      }
    });
    frame.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const now = { x: e.clientX, y: e.clientY };
      pointers.set(e.pointerId, now);
      if (pointers.size === 1) {
        x += now.x - prev.x;
        y += now.y - prev.y;
        draw();
      } else if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const rect = frame.getBoundingClientRect();
        zoomTo(pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist), (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
      }
    });
    const lift = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
    };
    frame.addEventListener('pointerup', lift);
    frame.addEventListener('pointercancel', lift);
    frame.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = frame.getBoundingClientRect();
      zoomTo(s * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
    slider.addEventListener('input', () => zoomTo(minS * (1 + (Number(slider.value) / 1000) * (MAX_ZOOM - 1))));

    draw();

    return new Promise((resolve) => {
      const finish = (blob) => {
        URL.revokeObjectURL(img.src);
        box.remove();
        resolve(blob);
      };
      box.querySelector('[data-crop=cancel]').addEventListener('click', () => finish(null));
      box.querySelector('[data-crop=use]').addEventListener('click', () => {
        // The framed part of the photo, in photo pixels, scaled down (never up) to the output size.
        const sx = -x / s;
        const sw = FW / s;
        const sh = (sw * outH) / outW; // exact output shape; the on-screen frame is rounded to whole pixels
        const sy = Math.max(0, Math.min(H - sh, -y / s));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(outW * Math.min(1, sw / outW));
        canvas.height = Math.round((canvas.width * outH) / outW);
        canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => finish(blob), 'image/jpeg', 0.85);
      });
    });
  }

  return { open };
})();
