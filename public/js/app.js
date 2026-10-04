/* 班级论坛 · 前端交互（无框架，渐进增强） */

(function () {
  'use strict';

  // 1) 危险操作二次确认
  document.addEventListener('submit', function (event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const message = form.getAttribute('data-confirm');
    if (!message) return;
    if (!window.confirm(message)) {
      event.preventDefault();
      return;
    }
    // 防止重复提交
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) {
      window.setTimeout(function () {
        submitButton.disabled = true;
        submitButton.dataset.originalText = submitButton.textContent;
        submitButton.textContent = '处理中…';
      }, 0);
    }
  });

  // 2) 移动端菜单：用 JS 直接切换（不依赖 label 切换 checkbox，避免 iOS 兼容问题）
  const toggle = document.getElementById('nav-toggle');
  const navLabel = document.querySelector('.nav-toggle-label');
  const navEl = document.querySelector('.nav');
  if (toggle && navLabel && navEl) {
    navLabel.addEventListener('click', function (event) {
      event.preventDefault();
      toggle.checked = !toggle.checked;
      navEl.classList.toggle('is-open', toggle.checked);
    });
    document.querySelectorAll('.nav a').forEach(function (link) {
      link.addEventListener('click', function () {
        toggle.checked = false;
        navEl.classList.remove('is-open');
      });
    });
    document.addEventListener('click', function (event) {
      if (!toggle.checked) return;
      const insideNav = event.target.closest('.nav');
      const insideLabel = event.target.closest('.nav-toggle-label');
      if (!insideNav && !insideLabel) {
        toggle.checked = false;
        navEl.classList.remove('is-open');
      }
    });
  }

  // 3) 字数计数器（给带 data-counter 的 textarea 用）
  document.querySelectorAll('textarea[data-counter]').forEach(function (textarea) {
    const target = document.getElementById(textarea.getAttribute('data-counter'));
    if (!target) return;
    const max = Number(textarea.getAttribute('maxlength')) || 0;
    const render = function () {
      target.textContent = max
        ? textarea.value.length + ' / ' + max + ' 字'
        : textarea.value.length + ' 字';
    };
    textarea.addEventListener('input', render);
    render();
  });

  // 4) 评论框快捷键：Ctrl/Cmd + Enter 提交
  document.querySelectorAll('textarea[data-submit-on-enter]').forEach(function (textarea) {
    textarea.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        const form = textarea.closest('form');
        if (form) form.requestSubmit();
      }
    });
  });

  // 5) 后台长内容折叠
  document.querySelectorAll('[data-collapse]').forEach(function (box) {
    const limit = Number(box.getAttribute('data-collapse')) || 240;
    const text = box.textContent || '';
    if (text.length <= limit) return;
    box.dataset.full = text;
    box.textContent = text.slice(0, limit) + '…';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--ghost btn--sm';
    button.textContent = '展开全文';
    button.addEventListener('click', function () {
      const expanded = button.textContent === '收起';
      box.textContent = expanded ? box.dataset.full.slice(0, limit) + '…' : box.dataset.full;
      button.textContent = expanded ? '展开全文' : '收起';
    });
    box.insertAdjacentElement('afterend', button);
  });
})();
