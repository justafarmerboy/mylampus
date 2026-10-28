'use strict';

// "Send feedback to the creator" dialog, shared by the map and owner pages.
// Any element with [data-feedback] opens it.

(() => {
  const isOwner = location.pathname.startsWith('/owner');
  const dlg = document.createElement('div');
  dlg.className = 'fb-backdrop hidden';
  dlg.innerHTML = `
    <form class="fb card" role="dialog" aria-modal="true" aria-labelledby="fb-title">
      <h2 id="fb-title">💬 ส่งความคิดเห็นถึงผู้สร้าง</h2>
      <p class="sub" style="margin:0">ชอบอะไร อยากให้เพิ่มอะไร หรือเจอปัญหา บอกได้เลย</p>
      <label for="fb-kind">เรื่อง</label>
      <select id="fb-kind">
        <option value="idea">💡 อยากให้เพิ่ม / ปรับปรุง</option>
        <option value="bug">🐞 แจ้งปัญหา</option>
        <option value="other">💬 อื่น ๆ</option>
      </select>
      <label for="fb-message">ข้อความ</label>
      <textarea id="fb-message" maxlength="1000" required rows="5" placeholder="พิมพ์ได้เลย…"></textarea>
      <label for="fb-contact">ช่องทางติดต่อกลับ (ไม่บังคับ)</label>
      <input id="fb-contact" maxlength="120" placeholder="เช่น LINE ID, เบอร์โทร หรืออีเมล">
      <button class="btn" type="submit">ส่ง</button>
      <button class="btn ghost" type="button" data-fb-close>ยกเลิก</button>
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
      if (res.status === 429) throw new Error('ส่งถี่เกินไป ลองใหม่อีกสักพักนะ');
      if (!res.ok) throw new Error('ส่งไม่สำเร็จ ลองใหม่อีกครั้ง');
      $('fb-message').value = '';
      $('fb-msg').textContent = 'ส่งแล้ว ขอบคุณมาก ✦';
      setTimeout(close, 1500);
    } catch (err) {
      $('fb-msg').textContent = err.message;
      $('fb-msg').classList.add('err');
    } finally {
      btn.disabled = false;
    }
  });
})();
