
  /* ============ 网络层捕获（document-start 立即生效） ============
     在 DeepSeek 服务器把回答流发到浏览器时就完整截获。
     无论页面渲染多卡、内容是否来得及显示就被撤回，都能拿到全文。 */
  var NCAP_KEY = 'ds_netcap_v1';
  var NCAP_MERGED_KEY = 'ds_netcap_merged_v1';
  (function () {
    if (window.__DS_NETCAP__) return;
    window.__DS_NETCAP__ = true;
    var caps = [];
    try { caps = JSON.parse(localStorage.getItem(NCAP_KEY) || '[]') || []; } catch (e) { caps = []; }
    var activeCount = 0;
    function saveCaps() { try { localStorage.setItem(NCAP_KEY, JSON.stringify(caps.slice(-50))); } catch (e) {} }
    function tryJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
    function feedText(rec, piece) {
      if (!piece) return;
      rec.lastAt = Date.now();
      if (rec.text && piece.length >= rec.text.length && piece.indexOf(rec.text) === 0) {
        rec.text = piece;                 // 累积快照式协议：整段替换
      } else {
        rec.text += piece;                // 增量式协议：追加
      }
      if (rec.text.length > 400000) rec.text = rec.text.slice(-400000);
    }
    function walk(rec, obj) {
      if (!obj || activeCount > 30) return;
      if (typeof obj === 'string') { feedText(rec, obj); return; }
      if (typeof obj !== 'object') return;
      for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        var v = obj[k];
        if (typeof v === 'string' && /^(content|delta|text|reasoning_content|reasoning|thinking)$/i.test(k)) {
          feedText(rec, v);
        } else if (v && typeof v === 'object') {
          walk(rec, v);
        }
      }
    }
    function processLine(rec, line) {
      line = String(line == null ? '' : line);
      line = line.replace(/\r/g, '').trim();
      if (!line || line.charAt(0) === ':') return;
      if (line.indexOf('data:') !== 0) { var j = tryJson(line); if (j) walk(rec, j); return; }
      var payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      var obj = tryJson(payload);
      if (obj) walk(rec, obj); else feedText(rec, payload);
    }
    function makeRec(url) {
      activeCount++;
      return { id: 'nc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), url: String(url || ''), text: '', startedAt: Date.now(), lastAt: Date.now(), done: false };
    }
    function finishRec(rec) {
      if (rec.done) return;
      rec.done = true; activeCount--;
      var t = (rec.text || '').trim();
      if (t.length >= 15) {
        caps.push({ id: rec.id, text: t, startedAt: rec.startedAt, endedAt: Date.now(), url: rec.url.slice(0, 120) });
        if (caps.length > 50) caps = caps.slice(-50);
        saveCaps();
      }
    }
    function shouldCapture(url, method, contentType) {
      if (activeCount > 30) return false;
      url = String(url || '');
      var hostHit = /deepseek\.(com|ai)/i.test(url) || url.charAt(0) === '/';
      if (!hostHit) return false;
      if (contentType && /event-stream/i.test(contentType)) return true;
      return /^post$/i.test(String(method || 'GET')) && /completion|chat|sse|stream/i.test(url);
    }
    function consumeStream(rec, body) {
      var reader, dec;
      try { reader = body.getReader(); dec = new TextDecoder(); }
      catch (e) { finishRec(rec); return; }
      var buf = '';
      (function step() {
        reader.read().then(function (r) {
          if (r.done) { if (buf) processLine(rec, buf); finishRec(rec); return; }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) processLine(rec, lines[i]);
          step();
        }).catch(function () { finishRec(rec); });
      })();
    }
    // ---- patch fetch ----
    try {
      var of = window.fetch;
      if (of) {
        window.fetch = function () {
          var args = arguments;
          var url = (args[0] && args[0].url) || args[0];
          var method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
          var p = of.apply(this, args);
          return p.then(function (res) {
            try {
              if (!res || !res.body) return res;
              var ct = ''; try { ct = res.headers.get('content-type') || ''; } catch (e) {}
              if (!shouldCapture(url, method, ct)) return res;
              if (!/event-stream|json|text/i.test(ct)) return res;
              var rec = makeRec(url);
              var clone = res.clone();
              consumeStream(rec, clone.body);
            } catch (e) {}
            return res;
          });
        };
      }
    } catch (e) {}
    // ---- patch XHR ----
    try {
      var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) {
        try { this.__dsU = String(u || ''); this.__dsM = m; } catch (e) {}
        return XO.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        try {
          if (!xhr.__dsHooked && /completion|chat|sse|stream/i.test(String(xhr.__dsU || ''))) {
            xhr.__dsHooked = true;
            var rec = null, seen = 0;
            function ensure() {
              if (!rec && activeCount <= 30) {
                var ct = ''; try { ct = xhr.getResponseHeader('content-type') || ''; } catch (e) {}
                if (shouldCapture(xhr.__dsU, xhr.__dsM, ct)) rec = makeRec(xhr.__dsU);
              }
              return rec;
            }
            xhr.addEventListener('progress', function () {
              try {
                if (xhr.responseType && xhr.responseType !== 'text') return;
                var txt = xhr.responseText || '';
                if (!ensure()) { seen = txt.length; return; }
                if (txt.length <= seen) return;
                var fresh = txt.slice(seen); seen = txt.length;
                var lines = fresh.split('\n');
                for (var i = 0; i < lines.length; i++) processLine(rec, lines[i]);
              } catch (e) {}
            });
            xhr.addEventListener('loadend', function () { if (rec) finishRec(rec); });
          }
        } catch (e) {}
        return XS.apply(this, arguments);
      };
    } catch (e) {}
    // ---- patch EventSource（备用通道） ----
    try {
      var OE = window.EventSource;
      if (OE) {
        var NewES = function (url, cfg) {
          var es = new OE(url, cfg);
          try {
            var ctOK = true;
            if (shouldCapture(url, 'GET', 'text/event-stream')) {
              var rec = makeRec(url);
              es.addEventListener('message', function (ev) { try { processLine(rec, 'data:' + ev.data); } catch (e) {} });
              es.addEventListener('error', function () { finishRec(rec); });
            }
          } catch (e) {}
          return es;
        };
        NewES.prototype = OE.prototype;
        window.EventSource = NewES;
      }
    } catch (e) {}
  })();
  