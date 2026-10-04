/* 头像圆形裁剪（弹窗式）：点头像 → 弹窗 → 选图 → 拖动定位 → 调大小 → 确定 */
(function () {
  'use strict';

  const modal = document.getElementById('avatar-modal');
  const stage = document.getElementById('avatar-stage');
  if (!modal || !stage) return;

  const img = document.getElementById('avatar-img');
  const mask = document.getElementById('avatar-mask');
  const hint = document.getElementById('avatar-hint');
  const fileInput = document.getElementById('avatar-file');
  const pickBtn = document.getElementById('avatar-pick');
  const radiusInput = document.getElementById('avatar-radius');
  const saveBtn = document.getElementById('avatar-save');
  const csrf = (document.querySelector('input[name="_csrf"]') || {}).value || '';

  const STAGE = 280;

  let image = null;
  let scale = 1;
  let dispW = 0, dispH = 0;
  let left = 0, top = 0;
  let dragging = false;
  let dragStart = { x: 0, y: 0, left: 0, top: 0 };

  function radius() { return Math.min(Number(radiusInput.value) || 110, STAGE / 2); }
  function cx() { return STAGE / 2; }
  function cy() { return STAGE / 2; }

  function applyLayout() {
    if (!image) return;
    const r = radius();
    const cX = cx(), cY = cy();

    // 约束：图片必须覆盖裁剪框（圆在图片内，圆圈不超出图片）
    left = Math.min(left, cX - r);
    left = Math.max(left, cX + r - dispW);
    top = Math.min(top, cY - r);
    top = Math.max(top, cY + r - dispH);

    img.style.left = left + 'px';
    img.style.top = top + 'px';
    img.style.width = dispW + 'px';
    img.style.height = dispH + 'px';

    const d = r * 2;
    mask.style.width = d + 'px';
    mask.style.height = d + 'px';
    mask.style.left = (cX - r) + 'px';
    mask.style.top = (cY - r) + 'px';
  }

  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) {
      alert('请选择图片文件。');
      return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
      const im = new Image();
      im.onload = function () {
        image = im;
        scale = Math.max(STAGE / im.naturalWidth, STAGE / im.naturalHeight);
        dispW = im.naturalWidth * scale;
        dispH = im.naturalHeight * scale;
        left = (STAGE - dispW) / 2;
        top = (STAGE - dispH) / 2;
        img.src = e.target.result;
        img.style.display = 'block';
        if (hint) hint.style.display = 'none';
        applyLayout();
      };
      im.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // 打开 / 关闭弹窗
  document.getElementById('avatar-open').addEventListener('click', function () {
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  });
  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = '';
  }
  document.querySelectorAll('[data-avatar-close]').forEach(function (el) {
    el.addEventListener('click', closeModal);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  pickBtn.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
  });
  radiusInput.addEventListener('input', applyLayout);

  // 拖动图片
  function getPoint(e) {
    const rect = stage.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }
  function pointerStart(e) {
    if (!image) return;
    dragging = true;
    const p = getPoint(e);
    dragStart = { x: p.x, y: p.y, left: left, top: top };
    stage.classList.add('is-dragging');
  }
  function pointerMove(e) {
    if (!dragging) return;
    e.preventDefault();
    const p = getPoint(e);
    left = dragStart.left + (p.x - dragStart.x);
    top = dragStart.top + (p.y - dragStart.y);
    applyLayout();
  }
  function pointerEnd() {
    dragging = false;
    stage.classList.remove('is-dragging');
  }

  stage.addEventListener('mousedown', pointerStart);
  window.addEventListener('mousemove', pointerMove);
  window.addEventListener('mouseup', pointerEnd);
  stage.addEventListener('touchstart', pointerStart, { passive: false });
  window.addEventListener('touchmove', pointerMove, { passive: false });
  window.addEventListener('touchend', pointerEnd);

  // 确定保存
  saveBtn.addEventListener('click', function () {
    if (!image) {
      alert('请先选择图片。');
      return;
    }
    const r = radius();
    const canvas = document.createElement('canvas');
    canvas.width = r * 2;
    canvas.height = r * 2;
    const ctx = canvas.getContext('2d');
    const sr = r / scale;
    const sx = (cx() - left) / scale - sr;
    const sy = (cy() - top) / scale - sr;
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(image, sx, sy, sr * 2, sr * 2, 0, 0, r * 2, r * 2);

    const dataUrl = canvas.toDataURL('image/png', 0.92);
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';

    fetch('/me/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ _csrf: csrf, avatar: dataUrl })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.ok) {
          // 更新页面上显示的头像（不刷新，体验更好）
          const entryImg = document.querySelector('.avatar-entry .avatar');
          if (entryImg && entryImg.tagName === 'IMG') {
            entryImg.src = data.avatar;
          } else if (entryImg) {
            const ni = document.createElement('img');
            ni.className = entryImg.className;
            ni.src = data.avatar;
            ni.alt = '';
            entryImg.replaceWith(ni);
          }
          closeModal();
        } else {
          alert((data && data.error) || '头像保存失败，请重试。');
        }
      })
      .catch(function () {
        alert('头像保存失败，请重试。');
      })
      .finally(function () {
        saveBtn.disabled = false;
        saveBtn.textContent = '确定';
      });
  });
})();
