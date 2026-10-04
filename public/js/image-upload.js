/* 帖子/评论的图片上传 + 表情面板 + 图片点击放大 */
(function () {
  'use strict';

  const EMOJIS = [
    '😀', '😄', '😂', '🤣', '😊', '😍', '🤔', '😅', '😭', '😡',
    '👍', '👎', '👏', '🙏', '💪', '🤝', '👌', '✌️', '🤟', '👋',
    '❤️', '💔', '🔥', '⭐', '✨', '🎉', '🎂', '🍀', '🌈', '☀️',
    '🐱', '🐶', '🐼', '🐸', '🦊', '🌸', '📚', '✏️', '🏫', '⚽'
  ];

  function getCsrf() {
    return (document.querySelector('input[name="_csrf"]') || {}).value || '';
  }

  function initUploader(box) {
    const textarea = document.getElementById(box.getAttribute('data-target'));
    const pickBtn = box.querySelector('[data-pick]');
    const fileInput = box.querySelector('[data-file]');
    const preview = box.querySelector('[data-preview]');
    const emojiBtn = box.querySelector('[data-emoji]');
    const emojiPanel = box.querySelector('[data-emoji-panel]');
    const imagesInput = box.querySelector('[data-images]');
    const maxImages = Number(box.getAttribute('data-max')) || 9;
    const single = maxImages === 1;

    let images = [];
    try {
      const raw = imagesInput && imagesInput.value;
      if (single) {
        images = raw ? [raw] : [];
      } else {
        images = raw ? JSON.parse(raw) : [];
      }
    } catch (_) {
      images = [];
    }

    function sync() {
      if (!imagesInput) return;
      imagesInput.value = single ? (images[0] || '') : JSON.stringify(images);
    }

    function renderPreview() {
      if (!preview) return;
      preview.innerHTML = '';
      images.forEach(function (url, i) {
        const wrap = document.createElement('div');
        wrap.className = 'image-uploader__item';
        const img = document.createElement('img');
        img.src = url;
        img.alt = '图片 ' + (i + 1);
        img.setAttribute('data-lightbox', '');
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'image-uploader__del';
        del.textContent = '×';
        del.setAttribute('aria-label', '删除');
        del.addEventListener('click', function () {
          images.splice(i, 1);
          renderPreview();
          sync();
        });
        wrap.appendChild(img);
        wrap.appendChild(del);
        preview.appendChild(wrap);
      });
    }

    function uploadFiles(files) {
      if (!files || !files.length) return;
      const fd = new FormData();
      fd.append('_csrf', getCsrf());
      for (const f of files) fd.append('files', f);

      const btn = pickBtn;
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '上传中…';

      fetch('/uploads', { method: 'POST', body: fd })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data && data.ok) {
            for (const f of data.files) {
              if (images.length >= maxImages) break;
              images.push(f.url);
            }
            renderPreview();
            sync();
          } else {
            alert((data && data.error) || '图片上传失败。');
          }
        })
        .catch(function () {
          alert('图片上传失败，请重试。');
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = old;
          fileInput.value = '';
        });
    }

    if (pickBtn && fileInput) {
      pickBtn.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        uploadFiles(fileInput.files);
      });
    }

    // 表情面板
    if (emojiBtn && emojiPanel) {
      if (!emojiPanel.innerHTML) {
        EMOJIS.forEach(function (ch) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'emoji-panel__item';
          b.textContent = ch;
          b.addEventListener('click', function () {
            insertAtCursor(textarea, ch);
          });
          emojiPanel.appendChild(b);
        });
      }
      emojiBtn.addEventListener('click', function () {
        emojiPanel.hidden = !emojiPanel.hidden;
      });
    }

    renderPreview();
  }

  function insertAtCursor(textarea, text) {
    if (!textarea) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  document.querySelectorAll('[data-image-uploader]').forEach(initUploader);

  // 点击图片放大（lightbox）
  let lightbox = null;
  function openLightbox(src) {
    if (!lightbox) {
      lightbox = document.createElement('div');
      lightbox.className = 'lightbox';
      lightbox.innerHTML = '<img alt="图片预览"><button class="lightbox__close" aria-label="关闭">×</button>';
      lightbox.addEventListener('click', function (e) {
        if (e.target !== lightbox.querySelector('img')) closeLightbox();
      });
      document.body.appendChild(lightbox);
    }
    lightbox.querySelector('img').src = src;
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeLightbox() {
    if (lightbox) lightbox.hidden = true;
    document.body.style.overflow = '';
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeLightbox();
  });

  document.addEventListener('click', function (e) {
    const img = e.target.closest && e.target.closest('img[data-lightbox]');
    if (img) openLightbox(img.getAttribute('src'));
  });
})();
