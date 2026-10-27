/* ============================================================
 * DeepSeek 留痕 · 安卓适配层
 * 在留痕脚本之前注入，负责把网页能力桥接到安卓原生：
 *   - 导出文件（blob / data URL）→ 保存到手机
 *   - 复制到剪贴板 → 系统剪贴板
 *   - 外链 → 系统浏览器打开
 * ============================================================ */
(function () {
  'use strict';
  if (window.__DS_ANDROID_SHIM__) return;
  window.__DS_ANDROID_SHIM__ = true;

  var BR = window.DSLoggerBridge;
  if (!BR) return;

  /* ---------- 1. 拦截 <a download> 导出，改为保存到手机 ---------- */
  var origClick = HTMLAnchorElement.prototype.click;

  function saveViaBridge(name, text) {
    try {
      BR.saveText(name || ('留痕_' + Date.now() + '.txt'), text);
    } catch (e) {
      try { BR.toastMsg('保存失败：' + e.message); } catch (e2) {}
    }
  }

  HTMLAnchorElement.prototype.click = function () {
    var self = this;
    try {
      var href = self.getAttribute('href') || '';
      var name = self.getAttribute('download') || '';
      if (name && (href.indexOf('blob:') === 0 || href.indexOf('data:') === 0)) {
        fetch(href)
          .then(function (r) { return r.text(); })
          .then(function (txt) { saveViaBridge(name, txt); })
          .catch(function () { try { origClick.apply(self, arguments); } catch (e) {} });
        return;
      }
    } catch (e) {}
    return origClick.apply(this, arguments);
  };

  /* ---------- 2. 剪贴板桥接 ---------- */
  try {
    var fakeWrite = function (t) {
      return new Promise(function (resolve) {
        try { BR.copyText(String(t == null ? '' : t)); } catch (e) {}
        resolve();
      });
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText = fakeWrite;
    } else {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: fakeWrite },
        configurable: true
      });
    }
  } catch (e) {}

  /* ---------- 3. 外链交给系统浏览器 ---------- */
  var origOpen = window.open;
  window.open = function (url) {
    if (url && typeof url === 'string' &&
        url.indexOf('http') === 0 &&
        url.indexOf('deepseek.com') < 0) {
      try { BR.openUrl(url); return null; } catch (e) {}
    }
    return origOpen.apply(window, arguments);
  };

  /* ---------- 4. 适配手机窄屏：面板全宽、按钮加大 ---------- */
  var css = document.createElement('style');
  css.textContent =
    '@media (max-width:600px){' +
    ' #dslg-panel{width:100vw!important;}' +
    ' #dslg-fab{bottom:96px!important;right:10px!important;padding:12px 18px!important;font-size:15px!important;}' +
    ' #dslg-pop{width:96vw!important;max-height:86vh!important;}' +
    ' .dslg-body,.latest .lv-text{font-size:15px!important;line-height:1.75!important;}' +
    ' .ops button,.dslg-acts button,.pop-foot button{padding:12px!important;font-size:14px!important;}' +
    ' #dslg-tabs .tab{padding:13px 0!important;}' +
    '}';
  (document.head || document.documentElement).appendChild(css);
})();
