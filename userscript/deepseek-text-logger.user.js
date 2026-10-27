// ==UserScript==
// @name         DeepSeek 文字留痕（可视化控制台 · 安全规则撤回自动拦截）
// @namespace    local.ds.textlogger
// @version      1.6.3
// @description  网络层+页面层双捕获：服务器发到浏览器的回答全文在网关处即被截获（SSE/流式），即使页面渲染卡顿、内容未显示就被安全规则撤回，也能拿到完整原文并自动弹窗。悬浮按钮可拖动并自动记住位置。含可视化控制台。快捷键 Alt+L。
// @author       DeepSeek Text Logger contributors
// @match        https://chat.deepseek.com/*
// @match        https://www.deepseek.com/*
// @match        https://deepseek.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.__DS_TEXT_LOGGER__) return;
  window.__DS_TEXT_LOGGER__ = true;

  /* ============ 设置 ============ */
  var SET_KEY = 'ds_text_logger_settings_v1';
  var S = { autoPopup: true, sound: true, captureAI: true, captureUser: true, autoOpen: false, captureHistory: false, maxKeep: 2000 };
  try {
    var _saved = JSON.parse(localStorage.getItem(SET_KEY) || '{}');
    for (var _k in S) if (typeof _saved[_k] !== 'undefined') S[_k] = _saved[_k];
  } catch (e) {}
  function saveSettings() { try { localStorage.setItem(SET_KEY, JSON.stringify(S)); } catch (e) {} }

  function beep() {
    if (!S.sound) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.5);
      setTimeout(function () { try { ctx.close(); } catch (e) {} }, 900);
    } catch (e) {}
  }

  /*__NETCAP_START__*/
  /*__DSLG_CORE_START__*/
  /* ============ v1.6.2 核心：文本快照（正文先保存，状态后判定） ============
     规则：任何"较短文本"都不得覆盖已保存的较长正文；撤回/替换只改状态，不改正文。
     注意：本段位于 NETCAP 标记内，构建产物 ds_netcap.js 与主脚本共用（window 级守卫防重复定义）。 */
  var DSLG_CORE = window.__DSLG_CORE__ || (window.__DSLG_CORE__ = (function () {
    function longer(a, b) {
      a = a || ''; b = b || '';
      return a.length >= b.length ? a : b;
    }
    // 单通道流累积：snapshot 链 + 增量累加 + 替换包留档；按"是否延续"归类，不整段乱拼
    function newChannel() { return { chain: '', acc: '', replaced: [], prevChains: [] }; }
    function feedChannel(ch, piece) {
      if (typeof piece !== 'string' || !piece) return;
      var cur = ch.chain || '';
      if (!cur || piece.indexOf(cur) === 0) {
        ch.chain = piece;                                    // 完整快照：延续当前链
      } else if (cur.indexOf(piece) === 0) {
        /* 旧的更短重复包：忽略 */
      } else if (piece.length <= cur.length) {
        if (ch.replaced.length < 3) ch.replaced.push(piece); // 更短的替换/提示包：留档、不串接
      } else {
        if (cur && ch.prevChains.length < 3) ch.prevChains.push(cur);
        ch.chain = piece;                                    // 更长但不延续：视为新链
      }
      if (ch.acc && piece.indexOf(ch.acc) === 0) ch.acc = piece;
      else if (ch.acc && ch.acc.indexOf(piece) === 0) { /* 重复包：忽略 */ }
      else ch.acc = (ch.acc || '') + piece;
      if (ch.acc.length > 400000) ch.acc = ch.acc.slice(-400000);
    }
    function pickChannel(ch) {
      var chain = ch.chain || '', acc = ch.acc || '';
      var best = longer(chain, acc);
      var replaced = (ch.replaced || []).slice(0, 3);
      // "大正文 + 小尾巴" → 尾巴判为替换/提示，正文取大块（chain 需足够大才启用该规则）
      if (chain.length >= 100 && acc.indexOf(chain) === 0 &&
          (acc.length - chain.length) <= Math.max(200, Math.floor(chain.length * 0.05))) {
        var tail = acc.slice(chain.length);
        if (tail) { best = chain; replaced.push(tail); }
      }
      return { best: best, replaced: replaced, prevChains: (ch.prevChains || []).slice(0, 3) };
    }
    // 条目文本更新：entry.text 只增不减；当前页面文字与替换文本另存
    function applyDomText(entry, value, now) {
      if (typeof value !== 'string') return false;
      value = value.trim();
      if (!value) return false;
      var changed = false;
      entry.currentText = value;
      if (value.length > (entry.maxDomText || '').length) { entry.maxDomText = value; changed = true; }
      if (value.length > (entry.text || '').length) { entry.text = value; changed = true; }
      else if (value.length < (entry.text || '').length) { entry.replacementText = value; }
      if (now) entry.lastSeen = now;
      return changed;
    }
    function applyNetText(entry, value) {
      if (typeof value !== 'string') return false;
      value = value.trim();
      if (!value) return false;
      var changed = false;
      if (value.length > (entry.maxNetText || '').length) entry.maxNetText = value;
      if (value.length > (entry.text || '').length) { entry.text = value; changed = true; }
      return changed;
    }
    // 恢复文本：只在"同一条目"的候选里取最长（身份由条目保证，不做跨条目拼接）
    function recoveryText(entry) {
      var cands = [entry.maxDomText, entry.maxNetText, entry.withdrawnText, entry.text].filter(Boolean);
      var best = '';
      for (var i = 0; i < cands.length; i++) best = longer(best, cands[i]);
      return best;
    }
    // 条目当前可用的"最长已知文本"（供网络层配对使用，防被短文本覆盖后失配）
    function entryLongestText(entry) {
      var best = longer(entry.text, longer(entry.maxDomText, entry.maxNetText));
      best = longer(best, entry.currentText);
      var vs = entry.versions || [];
      for (var i = 0; i < vs.length && i < 5; i++) best = longer(best, vs[i].text);
      return best;
    }
    return {
      longer: longer, newChannel: newChannel, feedChannel: feedChannel, pickChannel: pickChannel,
      applyDomText: applyDomText, applyNetText: applyNetText, recoveryText: recoveryText, entryLongestText: entryLongestText
    };
  })());
  /*__DSLG_CORE_END__*/
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
    function chanOf(rec, name) {
      if (!rec.ch) rec.ch = { main: DSLG_CORE.newChannel(), reason: DSLG_CORE.newChannel() };
      if (!rec.ch[name]) rec.ch[name] = DSLG_CORE.newChannel();
      return rec.ch[name];
    }
    function feedText(rec, piece, chan) {
      if (!piece) return;
      rec.lastAt = Date.now();
      DSLG_CORE.feedChannel(chanOf(rec, chan === 'reason' ? 'reason' : 'main'), String(piece));
    }
    function walk(rec, obj, chan) {
      if (!obj || activeCount > 30) return;
      if (typeof obj === 'string') { feedText(rec, obj, chan); return; }
      if (typeof obj !== 'object') return;
      for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        var v = obj[k];
        if (typeof v === 'string' && /^(content|delta|text|reasoning_content|reasoning|thinking)$/i.test(k)) {
          feedText(rec, v, /reasoning|thinking/i.test(k) ? 'reason' : 'main');
        } else if (v && typeof v === 'object') {
          walk(rec, v, chan);
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
      var main = DSLG_CORE.pickChannel(chanOf(rec, 'main'));
      var reason = DSLG_CORE.pickChannel(chanOf(rec, 'reason'));
      var t = String(main.best || '').trim();
      if (t.length < 15 && reason.best) { t = String(reason.best).trim(); main = reason; } // 兜底
      if (t.length >= 15) {
        caps.push({
          id: rec.id, text: t,
          replaced: (main.replaced || []).filter(function (s) { return s && s.length <= 2000; }).slice(0, 3),
          startedAt: rec.startedAt, endedAt: Date.now(), url: rec.url.slice(0, 120)
        });
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
  /*__NETCAP_END__*/

  function bootDSLogger() {

  /* ============ 存储 ============ */
  var LS_KEY = 'ds_text_logger_v1';
  var entries = [];
  try { entries = JSON.parse(localStorage.getItem(LS_KEY) || '[]') || []; } catch (e) { entries = []; }

  function uid() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  var saveTimer = null;
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try { localStorage.setItem(LS_KEY, JSON.stringify(visibleEntries().slice(-S.maxKeep))); } catch (e) {}
      updateBadge();
    }, 400);
  }
  function saveNow() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(visibleEntries().slice(-S.maxKeep))); } catch (e) {}
  }
  // 隐藏条目（开启"只保留被撤回内容"时的普通回答）不落盘、不展示
  function visibleEntries() {
    return entries.filter(function (e) { return !e.hidden; });
  }

  function nowStr(ts) {
    var d = new Date(ts || Date.now());
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ============ 捕获：AI 回答块（含流式） ============ */
  var slots = {}; // 顺序槽位 -> {id,text}
  var lastNoticeAt = 0; // 最近一次页面出现"撤回提示"块的时间（用于关联网络捕获）

  function dedupeNodes(nodes) {
    // 去掉互相嵌套的节点，只留内层实际承载文字的
    return nodes.filter(function (n) {
      for (var i = 0; i < nodes.length; i++) {
        var o = nodes[i];
        if (o !== n && n.contains(o)) return false;
      }
      return true;
    });
  }

  function aiBlocks() {
    var nodes = [];
    // DeepSeek 官方渲染容器（类名稳定部分）
    document.querySelectorAll('.ds-markdown').forEach(function (n) { nodes.push(n); });
    // 兜底：类名改版后，用通用特征匹配
    if (!nodes.length) {
      document.querySelectorAll('[class*="markdown"],[class*="message-content"],[class*="answer-content"],[class*="bubble"]').forEach(function (n) {
        var t = (n.innerText || '').trim();
        if (t.length >= 10) nodes.push(n);
      });
    }
    return dedupeNodes(nodes).filter(function (n) {
      if (n.closest && n.closest('#dslg-panel,#dslg-pop,#dslg-fab')) return false; // 工具自身界面跳过
      var r = n.getBoundingClientRect();
      return r.width > 0 || n.offsetHeight > 0 || n.innerText.length > 0;
    });
  }

  function normText(el) {
    return (el.innerText || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* 启动宽限期：页面刚打开（或切换会话）时已经存在的内容属于历史，
     不作为新捕获，也绝不参与"被撤回"判定 —— 这是避免误判的关键 */
  var BOOT_TS = Date.now();
  var BOOT_GRACE = 10000;
  var lastHref = location.href;
  function inGrace() { return Date.now() - BOOT_TS < BOOT_GRACE; }
  function resetBaseline() {
    BOOT_TS = Date.now();
    slots = {};
    seenNotices = new WeakMap();
  }
  setInterval(function () {
    if (location.href !== lastHref) { lastHref = location.href; resetBaseline(); }
  }, 1000);

  // 该文本是否与已知历史内容相符（历史消息因虚拟滚动重新渲染时会走到这里）
  function matchHistory(text) {
    var head = text.slice(0, 40), i, k;
    for (i = entries.length - 1; i >= 0; i--) {
      var e = entries[i];
      if (e.role === 'AI' && e.preexisting && (e.text === text || e.text.slice(0, 40) === head)) return true;
    }
    for (k in slots) {
      var st = slots[k];
      if (st && st.preexisting && (st.text === text || st.text.slice(0, 40) === head)) return true;
    }
    return false;
  }

  function scan() {
    try { mergeNetCaps(); } catch (e) {}
    var blocks = aiBlocks();
    var aliveIds = {};
    var used = {};
    var pairs = [];
    var noticeThisScan = false;

    blocks.forEach(function (el, idx) {
      var text = normText(el);
      if (text.length < 2) return;
      pairs.push({ idx: idx, text: text, head: text.slice(0, 40), el: el });
    });

    // 先按文本前缀把块对应到已有槽位，避免页面重排导致下标错位被误判成"内容被替换"
    pairs.forEach(function (p) {
      var key = null, k;
      // ① 节点印记：同一 DOM 节点 = 同一条回答（最稳，不受重排影响）
      if (p.el && p.el.__dslgSid !== undefined && slots[p.el.__dslgSid] && !used[p.el.__dslgSid]) key = String(p.el.__dslgSid);
      // ② 前缀匹配（辅助线索）
      if (key === null) {
        for (k in slots) {
          if (used[k]) continue;
          var st = slots[k];
          if (!st) continue;
          if (st.head && (p.text.indexOf(st.head) === 0 || st.text.indexOf(p.head) === 0)) { key = k; break; }
        }
      }
      // ③ 下标兜底：仅允许"空槽位"，禁止短文本顶替已持有长正文的槽位
      if (key === null && slots[p.idx] && !used[p.idx] && (slots[p.idx].text || '').length < 12) key = String(p.idx);
      p.key = key;
      if (key !== null) {
        used[key] = true;
        if (p.el) { try { p.el.__dslgSid = String(key); } catch (e) {} } // 打上节点印记
      }
    });

    pairs.forEach(function (p) {
      // 任何路径下出现撤回提示都记录时间（用于关联网络层全文）
      if (isWithdrawNotice(p.text) && p.text.length <= 300) { lastNoticeAt = Date.now(); if (p.text.length <= 120) noticeThisScan = true; }
      var st = p.key !== null ? slots[p.key] : null;

      if (!st) {
        // 页面上新出现的回答块
        var pre = inGrace() || matchHistory(p.text);
        // 撤回提示块本身不入库，只记录时间用于关联网络捕获
        if (isWithdrawNotice(p.text) && p.text.length <= 120) {
          lastNoticeAt = Date.now();
          var wk = p.idx;
          while (used[wk]) wk++;
          used[wk] = true;
          slots[wk] = { id: 'notice', text: p.text, head: p.head, preexisting: true, observed: true };
          return;
        }
        // 若网络捕获已先入库（页面渲染前就被撤回的情形），复用该条目而不是新建
        var netReuse = null;
        for (var ri = entries.length - 1; ri >= 0; ri--) {
          var re = entries[ri];
          if (re.net && !re.alive && !re.slotBound && prefMatch(p.text, re.text || '')) { netReuse = re; break; }
        }
        var nk = p.idx;
        while (used[nk]) nk++;
        used[nk] = true;
        if (netReuse) {
          slots[nk] = { id: netReuse.id, text: netReuse.text, head: p.head, preexisting: false, observed: true };
          netReuse.alive = true;
          netReuse.slotBound = true;
          st = slots[nk];
        } else {
        slots[nk] = { id: uid(), text: p.text, head: p.head, preexisting: pre, observed: false };
        st = slots[nk];
        // 历史内容默认不记录，只登记为基线
        if (!pre || S.captureHistory) {
          entries.push({
            id: st.id, role: 'AI', firstSeen: Date.now(), lastSeen: Date.now(),
            text: p.text, versions: [], regenerated: 0, alive: true, expanded: false,
            hidden: !S.captureAI, preexisting: pre, observed: false
          });
          saveSoon();
        }
        }
      }

      var entry = null;
      for (var m = 0; m < entries.length; m++) if (entries[m].id === st.id) { entry = entries[m]; break; }
      if (entry) aliveIds[entry.id] = true;

      if (p.text !== st.text) {
        // 判定是否为流式增长（新文本是旧文本的严格延续）
        var grew = p.text.length > st.text.length && p.text.indexOf(st.text) === 0;
        var sameStream = grew || (st.text && p.text.indexOf(st.text.slice(0, Math.min(24, st.text.length))) === 0);
        var replacedShort = !sameStream && st.text.length >= 60 && p.text.length < st.text.length * 0.6;

        if (!sameStream && st.text.length >= 30 && entry) {
          entry.versions.push({ at: Date.now(), text: st.text });
          entry.regenerated = (entry.regenerated || 0) + 1;
          // 只有"宽限期后新出现的内容"才可能是刚被撤回的回答；历史内容一律不判
          if (!entry.preexisting && !st.preexisting && isWithdrawNotice(p.text)) {
            markWithdrawn(entry, st.text);
          } else if (!entry.preexisting && !st.preexisting && replacedShort) {
            // 大正文被更短文本替换（无提示/提示不匹配）→ 疑似撤回；正文保留在快照里
            entry.suspected = true;
            entry.replacementText = DSLG_CORE.longer(entry.replacementText, p.text);
          }
        }

        st.text = p.text;
        st.head = p.head;
        if (entry) {
          DSLG_CORE.applyDomText(entry, p.text, Date.now()); // 只增不减：短文本不覆盖长正文
          if (grew) entry.observed = true;
        }
        if (entry && (replacedShort || entry.suspected)) saveNow(); else saveSoon();
      }
    });

    // 标记存活/消失（页面重生成后旧块被移除 → 留痕保留并标红）
    var changed = false;
    entries.forEach(function (e) {
      if (e.role !== 'AI') return;
      var isAlive = !!aliveIds[e.id];
      if (!isAlive) {
        // 再用文字特征确认一次，避免槽位错位误判
        var head = e.text.slice(0, 40);
        blocks.forEach(function (b) {
          var t = b.innerText || '';
          if (t.indexOf(head) === 0) { isAlive = true; }
        });
      }
      if (e.alive && !isAlive && !e.withdrawn && !e.preexisting) {
        // 刚才还在页面上、这次突然消失：
        if ((Date.now() - BOOT_TS > 15000) && (noticeThisScan || (Date.now() - lastNoticeAt <= 5000))) {
          // 同次/近 5 秒内出现过撤回提示 → 判定为被撤回（覆盖"整块被替换/移除"场景）；刚切会话的 15 秒内不判
          markWithdrawn(e, e.text);
        } else if (e.observed && !e.suspected && (Date.now() - BOOT_TS > 15000) &&
                   (Date.now() - e.lastSeen < 600000) && isNewestAi(e)) {
          // 无任何提示的静默消失，且是当前最新一条回答 → 记"疑似撤回"（不弹窗）
          e.suspected = true; changed = true;
        }
      }
      if (isAlive && e.suspected) { e.suspected = false; changed = true; } // 重新出现 → 撤销疑似
      if (e.alive !== isAlive) { e.alive = isAlive; changed = true; }
    });
    if (changed) saveSoon();
  }

  function isNewestAi(e) {
    for (var i = 0; i < entries.length; i++) {
      var o = entries[i];
      if (o.role === 'AI' && o !== e && o.alive && o.firstSeen > e.firstSeen) return false;
    }
    return true;
  }

  /* ============ 安全规则撤回识别 ============ */
  var WITHDRAW_NOTICE_RE = /被撤回|已撤回|被撤|已撤|安全规则|安全政策|安全规范|触发.{0,4}安全|违反.{0,12}(规定|规则|规范|政策)|(系统|平台).{0,8}(拦截|屏蔽)|涉及.{0,12}(敏感|违规|不当)|无法回答|无法提供|withdrawn|removed due|safety (policy|guideline)|blocked by|triggered.{0,20}(safety|policy)|according to.{0,40}(policy|guideline)/i;
  function isWithdrawNotice(text) {
    text = (text || '').trim();
    if (!text || text.length > 300) return false;
    return WITHDRAW_NOTICE_RE.test(text);
  }

  function markWithdrawn(entry, oldText) {
    if (entry.withdrawn) return;
    // 历史内容永不判定为撤回
    if (entry.preexisting) return;
    entry.withdrawn = true;
    entry.withdrawnAt = Date.now();
    entry.hidden = false; // 被撤回的内容必须保留下来
    // 从历史快照里取最长可信文本（绝不把"当前页面上的短提示"当正文）
    entry.withdrawnText = DSLG_CORE.longer(entry.withdrawnText, DSLG_CORE.longer(DSLG_CORE.recoveryText(entry), oldText || ''));
    beep();
    if (S.autoPopup && !entry.popupShown) {
      entry.popupShown = true;
      setTimeout(function () { if (pop) showWithdrawPopup(entry); }, 0);
    }
    saveSoon(); updateBadge();
    if (panelOpen) renderActive();
  }

  // 独立撤回通知检测：DeepSeek 可能在回答块之外另插一条撤回/安全提示
  // 只处理"新出现且文本发生变化"的通知节点，历史通知在启动时一次性登记后不再触发
  var seenNotices = new WeakMap();
  function detectStandaloneNotices() {
    var els = document.querySelectorAll('[class*="notice"],[class*="warn"],[class*="toast"],[class*="error"]');
    var now = Date.now();
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest && el.closest('#dslg-panel,#dslg-pop,#dslg-fab')) continue; // 排除工具自身界面（统计卡等含"被撤回"字样）
      var t = (el.innerText || '').trim();
      var prev = seenNotices.get(el);
      seenNotices.set(el, t);
      if (prev === t) continue;                    // 同一节点内容没变 → 已处理过
      if (prev === undefined && inGrace()) continue; // 启动/切换会话时已存在的通知 → 视为历史
      if (el.closest && el.closest('.ds-markdown')) continue;
      if (t.length < 4 || t.length >= 300 || !isWithdrawNotice(t)) continue;
      var target = null;
      for (var k = entries.length - 1; k >= 0; k--) {
        var e = entries[k];
        if (e.role === 'AI' && !e.withdrawn && !e.preexisting && e.alive &&
            (e.text || '').length >= 20 && (now - e.lastSeen) < 120000) { target = e; break; }
      }
      if (target) markWithdrawn(target, target.text);
    }
  }
  setInterval(detectStandaloneNotices, 2000);

  /* ============ 合并网络层捕获 ============ */
  var MERGED = [];
  try { MERGED = JSON.parse(localStorage.getItem(NCAP_MERGED_KEY) || '[]') || []; } catch (e) {}
  function markMerged(id) {
    MERGED.push(id);
    if (MERGED.length > 300) MERGED = MERGED.slice(-300);
    try { localStorage.setItem(NCAP_MERGED_KEY, JSON.stringify(MERGED)); } catch (e) {}
  }
  function prefMatch(a, b) {
    a = a || ''; b = b || '';
    var n = Math.min(24, a.length, b.length);
    if (n < 8) return false;
    return a.slice(0, n) === b.slice(0, n);
  }
  function mergeNetCaps() {
    var caps = [];
    try { caps = JSON.parse(localStorage.getItem(NCAP_KEY) || '[]') || []; } catch (e) {}
    if (!caps.length) return;
    var changed = false;
    for (var i = 0; i < caps.length; i++) {
      var cap = caps[i];
      if (MERGED.indexOf(cap.id) >= 0) continue;
      var pair = null;
      for (var k = entries.length - 1; k >= 0; k--) {
        var e = entries[k];
        if (e.role !== 'AI' || e.preexisting || e.net) continue;
        // 用"历史最长文本"配对：entry.text 被短文本覆盖后仍能匹配到长捕获
        if (prefMatch(cap.text, DSLG_CORE.entryLongestText(e))) { pair = e; break; }
      }
      if (pair) {
        DSLG_CORE.applyNetText(pair, cap.text);
        pair.netText = DSLG_CORE.longer(pair.netText, cap.text);
        if (cap.replaced && cap.replaced.length) {
          var rt = cap.replaced.slice().sort(function (a, b) { return b.length - a.length; })[0];
          pair.replacementText = DSLG_CORE.longer(pair.replacementText, rt);
        }
        if (pair.withdrawn) {
          var rec = DSLG_CORE.recoveryText(pair);
          if (rec.length > (pair.withdrawnText || '').length) {
            pair.withdrawnText = rec;
            // 若弹窗正显示这条，同步刷新为全文
            if (typeof popEntry !== 'undefined' && popEntry === pair && pop && pop.style.display === 'flex') {
              pop.querySelector('#dslg-pop-body').textContent = rec;
            }
          }
        }
        pair.net = true;
        markMerged(cap.id); changed = true;
      } else if ((Date.now() - cap.endedAt > 15000) ||
                 (Date.now() - cap.endedAt > 3000 && lastNoticeAt && lastNoticeAt >= cap.startedAt - 3000)) {
        // 服务器发了全文但页面从未渲染（渲染前就被撤回）→ 独立入库
        var ne = {
          id: uid(), role: 'AI', firstSeen: cap.startedAt, lastSeen: cap.endedAt,
          text: cap.text, versions: [], regenerated: 0, alive: false, expanded: false,
          hidden: !S.captureAI, preexisting: false, observed: true, net: true
        };
        entries.push(ne);
        // 若流式期间页面出现过撤回提示 → 标记为被撤回并弹窗
        if (lastNoticeAt && lastNoticeAt >= cap.startedAt - 3000 && !ne.withdrawn && !ne.preexisting) {
          ne.netText = cap.text;
          ne.hidden = false;
          ne.slotBound = true;
          markWithdrawn(ne, cap.text);
        }
        markMerged(cap.id); changed = true;
      }
    }
    if (changed) { saveNow(); updateBadge(); if (panelOpen) renderActive(); }
  }

  /* ============ 捕获：用户发送的提问 ============ */
  var lastUserText = '', lastUserAt = 0;
  function addUser(text) {
    text = (text || '').trim();
    if (!text || !S.captureUser) return;
    var now = Date.now();
    if (text === lastUserText && now - lastUserAt < 3000) return;
    lastUserText = text; lastUserAt = now;
    // 去重（DOM 扫描与输入框捕获可能重复）
    for (var i = entries.length - 1; i >= Math.max(0, entries.length - 5); i--) {
      if (entries[i].role === '我' && entries[i].text === text) return;
    }
    entries.push({ id: uid(), role: '我', firstSeen: now, lastSeen: now, text: text, versions: [], alive: true });
    saveSoon();
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target) {
      var t = e.target;
      if (t.closest && t.closest('#dslg-panel,#dslg-pop,#dslg-fab')) return; // 工具自身输入框（如搜索框）不记录
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable) {
        addUser(t.value !== undefined ? t.value : t.innerText);
      }
    }
  }, true);

  /* ============ 监听调度 ============ */
  var scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () { scanTimer = null; scan(); if (panelOpen) renderActive(); }, 350);
  }
  var mo = new MutationObserver(scheduleScan);
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setInterval(function () { scan(); if (panelOpen) renderActive(); }, 1200);
  scan();

  /* ============ 界面 ============ */
  var style = document.createElement('style');
  style.textContent = `
  #dslg-fab{position:fixed;right:14px;bottom:84px;z-index:2147483000;background:#1d4ed8;color:#fff;border:none;border-radius:24px;padding:10px 16px;font-size:14px;font-weight:700;box-shadow:0 6px 20px rgba(29,78,216,.4);cursor:grab;display:flex;align-items:center;gap:6px;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;touch-action:none;user-select:none;-webkit-user-select:none}
  #dslg-fab .n{background:#fff;color:#1d4ed8;border-radius:10px;padding:0 7px;font-size:12px;line-height:18px;min-width:18px;text-align:center}
  #dslg-fab .n.dead{background:#ef4444;color:#fff}
  #dslg-panel{position:fixed;top:0;right:0;bottom:0;width:min(440px,92vw);z-index:2147483001;background:#fff;box-shadow:-8px 0 30px rgba(0,0,0,.18);display:none;flex-direction:column;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  #dslg-panel.show{display:flex}
  #dslg-head{background:#1d4ed8;color:#fff;padding:14px 16px;display:flex;align-items:center;gap:8px}
  #dslg-head b{font-size:16px}
  #dslg-head .x{margin-left:auto;cursor:pointer;font-size:20px;line-height:1;padding:2px 6px;border-radius:6px}
  #dslg-head .x:hover{background:rgba(255,255,255,.2)}
  #dslg-tools{display:flex;gap:6px;padding:10px 12px;border-bottom:1px solid #eef0f4;flex-wrap:wrap}
  #dslg-tools button,#dslg-tools input{font-size:13px;border-radius:8px;border:1px solid #d7dbe3;padding:7px 10px;background:#fff;cursor:pointer}
  #dslg-tools input{flex:1;min-width:120px;cursor:text}
  #dslg-tools button:hover{background:#f3f6ff;border-color:#1d4ed8}
  #dslg-tools .danger:hover{background:#fef2f2;border-color:#ef4444;color:#ef4444}
  #dslg-list{flex:1;overflow-y:auto;padding:10px 12px 30px;background:#f7f8fa}
  .dslg-empty{text-align:center;color:#9aa1af;font-size:13px;padding:50px 20px;line-height:2}
  .dslg-item{background:#fff;border:1px solid #eef0f4;border-radius:12px;margin-bottom:10px;overflow:hidden}
  .dslg-item.dead{border-color:#fca5a5;background:#fff7f7}
  .dslg-ih{display:flex;align-items:center;gap:8px;padding:9px 12px;font-size:12px;color:#6b7280;cursor:pointer;user-select:none}
  .dslg-badge{font-size:11px;font-weight:700;padding:1px 8px;border-radius:9px}
  .dslg-badge.ai{background:#dbeafe;color:#1d4ed8}
  .dslg-badge.me{background:#dcfce7;color:#15803d}
  .dslg-badge.live{background:#d1fae5;color:#047857}
  .dslg-badge.gone{background:#fee2e2;color:#dc2626}
  .dslg-badge.regen{background:#fef3c7;color:#b45309}
  .dslg-badge.net{background:#e0e7ff;color:#4338ca}
  .dslg-ih .sp{margin-left:auto}
  .dslg-body{padding:0 12px 10px;font-size:14px;line-height:1.7;color:#1f2937;white-space:pre-wrap;word-break:break-word;display:none}
  .dslg-item.open .dslg-body{display:block}
  .dslg-body .ver{margin-top:8px;padding:8px 10px;background:#f8fafc;border-left:3px solid #f59e0b;border-radius:6px;font-size:13px;color:#6b7280;white-space:pre-wrap}
  .dslg-acts{display:none;gap:6px;padding:0 12px 10px}
  .dslg-item.open .dslg-acts{display:flex}
  .dslg-acts button{font-size:12px;padding:5px 10px;border-radius:7px;border:1px solid #d7dbe3;background:#fff;cursor:pointer}
  .dslg-acts button:hover{background:#f3f6ff;border-color:#1d4ed8}
  #dslg-pop{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(580px,94vw);max-height:82vh;flex-direction:column;background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.4);z-index:2147483002;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden;border:2px solid #ef4444}
  #dslg-pop .pop-head{background:#b91c1c;color:#fff;padding:14px 18px;display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700}
  #dslg-pop .pop-head .x{margin-left:auto;cursor:pointer;font-size:22px;line-height:1;padding:0 4px;border-radius:6px}
  #dslg-pop .pop-head .x:hover{background:rgba(255,255,255,.2)}
  #dslg-pop .pop-body{flex:1;overflow-y:auto;padding:16px 18px;font-size:14px;line-height:1.8;color:#1f2937;white-space:pre-wrap;word-break:break-word;background:#fff}
  #dslg-pop .pop-foot{display:flex;gap:10px;padding:12px 18px;border-top:1px solid #eef0f4;background:#fafafa}
  #dslg-pop .pop-foot button{flex:1;padding:10px;border-radius:9px;border:1px solid #d7dbe3;background:#fff;cursor:pointer;font-size:14px;font-weight:600}
  #dslg-pop .pop-foot button:hover{background:#f3f6ff;border-color:#1d4ed8}
  #dslg-pop .pop-foot button:first-child{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
  #dslg-pop .pop-foot button:first-child:hover{background:#1e40af}
  #dslg-head .ver{font-size:11px;background:rgba(255,255,255,.22);padding:1px 7px;border-radius:8px}
  #dslg-tabs{display:flex;border-bottom:1px solid #eef0f4;background:#fff}
  #dslg-tabs .tab{flex:1;padding:11px 0;border:none;background:none;font-size:14px;color:#6b7280;cursor:pointer;border-bottom:2px solid transparent;font-family:inherit}
  #dslg-tabs .tab.active{color:#1d4ed8;font-weight:700;border-bottom-color:#1d4ed8}
  #dslg-tabs .tab:hover{background:#f8faff}
  .view{flex:1;overflow-y:auto;display:none;padding:12px;background:#f7f8fa}
  .view.active{display:block}
  #dslg-v-list{padding:0}
  .stats{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .stat{background:#fff;border:1px solid #eef0f4;border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}
  .stat .k{font-size:22px;font-weight:800;color:#1d4ed8;line-height:1.2}
  .stat .l{font-size:12px;color:#6b7280}
  .stat.warn .k{color:#dc2626}
  .sec{background:#fff;border:1px solid #eef0f4;border-radius:12px;margin-top:10px;overflow:hidden}
  .sec-t{font-size:12px;font-weight:700;color:#374151;padding:10px 12px;border-bottom:1px solid #f1f3f7;background:#fbfcfe}
  .latest{padding:12px;font-size:13px;color:#1f2937}
  .latest.empty{color:#9aa1af;text-align:center;padding:22px}
  .latest .lv-meta{font-size:11px;color:#9aa1af;margin-bottom:6px}
  .latest .lv-text{white-space:pre-wrap;word-break:break-word;line-height:1.7;max-height:140px;overflow:hidden}
  .latest .lv-ops{display:flex;gap:8px;margin-top:10px}
  .latest .lv-ops button{font-size:12px;padding:6px 12px;border-radius:8px;border:1px solid #d7dbe3;background:#fff;cursor:pointer;font-family:inherit}
  .latest .lv-ops button:hover{background:#f3f6ff;border-color:#1d4ed8}
  .ops{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px}
  .ops button{font-size:13px;padding:10px;border-radius:9px;border:1px solid #d7dbe3;background:#fff;cursor:pointer;font-family:inherit}
  .ops button:hover{background:#f3f6ff;border-color:#1d4ed8}
  .ops button.wide{grid-column:1 / -1}
  .ops button.danger{border-color:#fca5a5;background:#fef2f2;color:#dc2626;font-weight:600}
  .ops button.danger:hover{background:#fee2e2}
  .status{padding:12px;font-size:12.5px;line-height:2;color:#4b5563}
  .status .ok{color:#047857;font-weight:700}
  .status .off{color:#dc2626;font-weight:700}
  .list-tools{display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid #eef0f4;background:#fff;align-items:center;flex-wrap:wrap}
  #dslg-search{flex:1;min-width:130px;font-size:13px;border-radius:8px;border:1px solid #d7dbe3;padding:7px 10px;font-family:inherit}
  .chk{font-size:12.5px;color:#4b5563;display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none}
  .set-item{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #eef0f4;border-radius:12px;padding:12px 14px;margin-bottom:8px}
  .si-t{flex:1}
  .si-t b{font-size:14px}
  .si-t p{font-size:12px;color:#9aa1af;margin-top:2px}
  .sw{position:relative;width:44px;height:26px;flex:0 0 auto}
  .sw input{opacity:0;width:0;height:0;position:absolute}
  .sw span{position:absolute;inset:0;background:#cbd5e1;border-radius:14px;transition:.2s;cursor:pointer}
  .sw span:before{content:"";position:absolute;width:20px;height:20px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
  .sw input:checked+span{background:#1d4ed8}
  .sw input:checked+span:before{transform:translateX(18px)}
  #dslg-maxkeep{font-size:13px;padding:7px 10px;border-radius:8px;border:1px solid #d7dbe3;background:#fff;font-family:inherit;cursor:pointer}
  .btn-danger{font-size:13px;padding:8px 16px;border-radius:8px;border:1px solid #fca5a5;background:#fef2f2;color:#dc2626;cursor:pointer;font-family:inherit;font-weight:600}
  .btn-danger:hover{background:#fee2e2}
  .tips{margin-top:12px;background:#fff;border:1px solid #eef0f4;border-radius:12px;padding:14px;font-size:12.5px;line-height:2;color:#4b5563}
  .tips code{background:#f1f5f9;padding:1px 6px;border-radius:5px;font-size:12px}
  `;
  document.documentElement.appendChild(style);

  var fab = document.createElement('button');
  fab.id = 'dslg-fab';
  fab.title = '点按打开控制台 · 按住可拖动位置';
  fab.innerHTML = '📝 留痕 <span class="n" id="dslg-count">0</span>';

  /* ---- 悬浮按钮可拖动（自动记住位置） ---- */
  var FAB_POS_KEY = 'dslg_fab_pos';
  var fabDragging = false, fabMoved = false, fabSuppressAt = 0;
  var fabStartX = 0, fabStartY = 0, fabStartL = 0, fabStartT = 0;

  function fabApplyPos(left, top) {
    var w = fab.offsetWidth || 90, h = fab.offsetHeight || 40;
    left = Math.max(2, Math.min(left, (window.innerWidth || 360) - w - 2));
    top = Math.max(2, Math.min(top, (window.innerHeight || 640) - h - 2));
    fab.style.left = left + 'px';
    fab.style.top = top + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
  }
  // 恢复上次拖动的位置
  try {
    var savedPos = JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null');
    if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
      fabApplyPos(savedPos.left, savedPos.top);
    }
  } catch (e) {}
  // 屏幕尺寸变化后防止按钮跑到屏幕外
  window.addEventListener('resize', function () {
    if (fab.style.left) {
      var r = fab.getBoundingClientRect();
      fabApplyPos(r.left, r.top);
    }
  });

  fab.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var r = fab.getBoundingClientRect();
    fabStartX = e.clientX; fabStartY = e.clientY;
    fabStartL = r.left; fabStartT = r.top;
    fabDragging = true; fabMoved = false;
    try { fab.setPointerCapture(e.pointerId); } catch (err) {}
  });
  fab.addEventListener('pointermove', function (e) {
    if (!fabDragging) return;
    var dx = e.clientX - fabStartX, dy = e.clientY - fabStartY;
    if (!fabMoved && Math.abs(dx) + Math.abs(dy) < 6) return; // 小于 6px 视为点按
    if (!fabMoved) { fabMoved = true; fab.style.opacity = '0.75'; fab.style.cursor = 'grabbing'; }
    fabApplyPos(fabStartL + dx, fabStartT + dy);
    if (e.cancelable) e.preventDefault();
  });
  fab.addEventListener('pointerup', function () {
    if (!fabDragging) return;
    fabDragging = false;
    fab.style.opacity = '';
    fab.style.cursor = '';
    if (fabMoved) {
      try {
        var r = fab.getBoundingClientRect();
        localStorage.setItem(FAB_POS_KEY, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
      } catch (e) {}
      fabSuppressAt = Date.now();
      toast('按钮位置已记住');
    }
  });
  fab.addEventListener('pointercancel', function () {
    fabDragging = false; fabMoved = false;
    fab.style.opacity = ''; fab.style.cursor = '';
  });
  fab.addEventListener('click', function () {
    if (fabSuppressAt && Date.now() - fabSuppressAt < 500) { fabSuppressAt = 0; return; }
    openDash('home');
  });
  document.documentElement.appendChild(fab);

  var panel = document.createElement('div');
  panel.id = 'dslg-panel';
  panel.innerHTML = `
    <div id="dslg-head">
      <span>📝</span><b>DeepSeek 文字留痕</b><span class="ver">v1.6.3</span>
      <span class="x" id="dslg-close">×</span>
    </div>
    <div id="dslg-tabs">
      <button class="tab active" data-tab="home">概览</button>
      <button class="tab" data-tab="list">记录</button>
      <button class="tab" data-tab="set">设置</button>
    </div>

    <div class="view active" id="dslg-v-home">
      <div class="stats">
        <div class="stat"><span class="k" id="st-total">0</span><span class="l">总记录</span></div>
        <div class="stat"><span class="k" id="st-today">0</span><span class="l">今日新增</span></div>
        <div class="stat"><span class="k" id="st-ai">0</span><span class="l">AI 回答</span></div>
        <div class="stat warn"><span class="k" id="st-wd">0</span><span class="l">被撤回</span></div>
      </div>
      <div class="sec">
        <div class="sec-t">⚠️ 最近一条被撤回的内容</div>
        <div id="home-latest" class="latest empty">暂无撤回记录</div>
      </div>
      <div class="sec">
        <div class="sec-t">快捷操作</div>
        <div class="ops">
          <button data-op="copyall">📋 复制全部</button>
          <button data-op="txt">💾 导出 TXT</button>
          <button data-op="json">📦 导出 JSON</button>
          <button data-op="scan">🔄 立即扫描</button>
          <button data-op="clear" class="wide danger">🗑️ 删除所有留痕</button>
        </div>
      </div>
      <div class="sec">
        <div class="sec-t">运行状态</div>
        <div id="home-status" class="status"></div>
      </div>
    </div>

    <div class="view" id="dslg-v-list">
      <div class="list-tools">
        <input id="dslg-search" placeholder="搜索已捕获文字…">
        <label class="chk"><input type="checkbox" id="dslg-onlywd"> 只看被撤回</label>
      </div>
      <div id="dslg-list"></div>
    </div>

    <div class="view" id="dslg-v-set">
      <div class="set-item">
        <div class="si-t"><b>撤回时自动弹窗</b><p>检测到回答被安全规则撤回，立即弹出原文</p></div>
        <label class="sw"><input type="checkbox" data-set="autoPopup"><span></span></label>
      </div>
      <div class="set-item">
        <div class="si-t"><b>撤回提示音</b><p>撤回发生时发出提示音，避免错过</p></div>
        <label class="sw"><input type="checkbox" data-set="sound"><span></span></label>
      </div>
      <div class="set-item">
        <div class="si-t"><b>记录 AI 回答</b><p>关闭后平时不留记录，只保留被撤回的内容</p></div>
        <label class="sw"><input type="checkbox" data-set="captureAI"><span></span></label>
      </div>
      <div class="set-item">
        <div class="si-t"><b>记录我的提问</b><p>保存你发送出去的问题原文</p></div>
        <label class="sw"><input type="checkbox" data-set="captureUser"><span></span></label>
      </div>
      <div class="set-item">
        <div class="si-t"><b>打开页面时自动展开控制台</b><p>每次打开 DeepSeek 自动弹出本面板，适合想随时盯着记录的场景</p></div>
        <label class="sw"><input type="checkbox" data-set="autoOpen"><span></span></label>
      </div>
      <div class="set-item">
        <div class="si-t"><b>记录打开页面时的历史消息</b><p>默认关闭。关闭时只记录你本次新产生的对话，历史消息不会被读取，也就不会被误判为"被撤回"</p></div>
        <label class="sw"><input type="checkbox" data-set="captureHistory"><span></span></label>
      </div>
      <div class="set-item">
        <div class="si-t"><b>保留条数上限</b><p>超出后自动丢弃最早的记录</p></div>
        <select id="dslg-maxkeep">
          <option value="200">200 条</option>
          <option value="500">500 条</option>
          <option value="2000">2000 条</option>
          <option value="10000">10000 条</option>
        </select>
      </div>
      <div class="set-item">
        <div class="si-t"><b>删除所有留痕</b><p>清空已捕获的全部文字与本地存储，不可恢复，建议先导出备份</p></div>
        <button class="btn-danger" data-op="clear">删除</button>
      </div>
      <div class="tips">
        <b>使用说明</b><br>
        • 网络级捕获：服务器发来的回答全文在网关处即被截获，页面渲染卡顿也不丢字<br>
        • 回答一出现在页面上就自动留痕，逐字生成过程也持续保存<br>
        • 触发安全规则被撤回时，自动弹窗显示被撤回的完整原文<br>
        • 点"重新生成"、删除消息、刷新页面都不会丢失记录<br>
        • 数据只存在本机浏览器，不上传任何服务器<br>
        • 快捷键 <code>Alt+L</code> 打开/关闭本控制台；也可在设置里开启自动展开
      </div>
    </div>`;
  document.documentElement.appendChild(panel);

  var panelOpen = false;
  var activeTab = 'home';

  function switchTab(t) {
    activeTab = t;
    panel.querySelectorAll('#dslg-tabs .tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === t);
    });
    panel.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('active', v.id === 'dslg-v-' + t);
    });
    if (t === 'home') renderOverview();
    if (t === 'list') renderList();
    if (t === 'set') renderSettings();
  }
  panel.querySelectorAll('#dslg-tabs .tab').forEach(function (b) {
    b.onclick = function () { switchTab(b.getAttribute('data-tab')); };
  });
  function openDash(t) {
    panel.classList.add('show'); panelOpen = true;
    switchTab(t || activeTab);
  }
  function closeDash() { panel.classList.remove('show'); panelOpen = false; }
  panel.querySelector('#dslg-close').onclick = closeDash;
  document.addEventListener('keydown', function (e) {
    if (e.altKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      panelOpen ? closeDash() : openDash();
    }
  }, true);

  function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }

  function renderOverview() {
    if (!panelOpen) return;
    var t0 = new Date(); t0.setHours(0, 0, 0, 0); t0 = t0.getTime();
    var list = visibleEntries();
    var wd = list.filter(function (e) { return e.withdrawn; });
    setText('st-total', list.length);
    setText('st-today', list.filter(function (e) { return e.firstSeen >= t0; }).length);
    setText('st-ai', list.filter(function (e) { return e.role === 'AI'; }).length);
    setText('st-wd', wd.length);

    var box = document.getElementById('home-latest');
    if (box) {
      if (!wd.length) {
        box.className = 'latest empty';
        box.textContent = '暂无撤回记录';
      } else {
        var last = wd[wd.length - 1];
        var txt = last.withdrawnText || last.text;
        box.className = 'latest';
        box.innerHTML = '<div class="lv-meta">' + nowStr(last.withdrawnAt || last.firstSeen) + ' · ' + txt.length + ' 字</div>' +
          '<div class="lv-text">' + esc(txt.slice(0, 400)) + '</div>' +
          '<div class="lv-ops"><button data-op="copylast">📋 复制原文</button><button data-op="showlast">👁 完整查看</button></div>';
      }
    }
    var st = document.getElementById('home-status');
    if (st) {
      st.innerHTML =
        '当前页面：<b>' + esc(location.hostname || '本地页面') + '</b><br>' +
        '捕获范围：' + (S.captureAI ? '<span class="ok">AI 回答 ✓</span>' : '<span class="off">AI 回答 ✗（仅留撤回）</span>') +
        ' ｜ ' + (S.captureUser ? '<span class="ok">我的提问 ✓</span>' : '<span class="off">我的提问 ✗</span>') + '<br>' +
        '撤回弹窗：' + (S.autoPopup ? '<span class="ok">开</span>' : '<span class="off">关</span>') +
        ' ｜ 提示音：' + (S.sound ? '<span class="ok">开</span>' : '<span class="off">关</span>') + '<br>' +
        '保留上限：' + S.maxKeep + ' 条 ｜ 数据仅存本机';
    }
  }

  function renderSettings() {
    if (!panelOpen) return;
    panel.querySelectorAll('[data-set]').forEach(function (el) {
      el.checked = !!S[el.getAttribute('data-set')];
    });
    var mk = document.getElementById('dslg-maxkeep');
    if (mk) mk.value = String(S.maxKeep);
  }

  function renderActive() {
    if (!panelOpen) return;
    renderOverview();
    renderSettings();
    if (activeTab === 'list') renderList();
  }

  panel.querySelectorAll('[data-set]').forEach(function (el) {
    el.addEventListener('change', function () {
      var key = el.getAttribute('data-set');
      S[key] = el.checked;
      saveSettings();
      // 切换"记录历史消息"后重新登记基线，让设置立即生效
      if (key === 'captureHistory') resetBaseline();
      renderOverview(); renderSettings();
      toast('设置已保存');
    });
  });
  var mkSel = document.getElementById('dslg-maxkeep');
  if (mkSel) mkSel.onchange = function () {
    S.maxKeep = parseInt(mkSel.value, 10) || 2000;
    saveSettings(); renderOverview(); toast('保留上限已设为 ' + S.maxKeep + ' 条');
  };

  panel.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-op]') : null;
    if (!b || !panel.contains(b)) return;
    var op = b.getAttribute('data-op');
    if (op === 'copyall') {
      copyText(visibleEntries().map(entryBody).join('\n\n' + '='.repeat(30) + '\n\n'), '已复制全部正文 ' + visibleEntries().length + ' 条');
    } else if (op === 'txt') {
      download('DeepSeek留痕_' + stamp() + '.txt', visibleEntries().map(buildText).join('\n\n' + '='.repeat(40) + '\n\n'));
      toast('已导出 TXT');
    } else if (op === 'json') {
      download('DeepSeek留痕_' + stamp() + '.json', JSON.stringify(visibleEntries(), null, 2), 'application/json');
      toast('已导出 JSON');
    } else if (op === 'scan') {
      scan(); renderActive(); toast('已重新扫描页面');
    } else if (op === 'clear') {
      clearAll();
    } else if (op === 'copylast') {
      var wl = visibleEntries().filter(function (x) { return x.withdrawn; });
      if (wl.length) copyText(wl[wl.length - 1].withdrawnText || wl[wl.length - 1].text, '已复制被撤回原文');
    } else if (op === 'showlast') {
      var wl2 = visibleEntries().filter(function (x) { return x.withdrawn; });
      if (wl2.length) showWithdrawPopup(wl2[wl2.length - 1]);
    }
  });

  panel.querySelector('#dslg-search').addEventListener('input', renderList);
  panel.querySelector('#dslg-onlywd').addEventListener('change', renderList);

  /* ============ 删除所有留痕（彻底清除） ============ */
  function clearAll() {
    if (!confirm('确定删除所有留痕记录？\n\n这会清空已捕获的全部文字和本地存储，不可恢复。\n建议先点「导出 TXT」备份。')) return;
    entries = [];
    slots = {};
    hidePop();
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    resetBaseline();   // 重置基线，让当前页面内容被视为历史，避免清空后立刻被重新捕获
    renderActive(); updateBadge(); toast('✅ 已删除所有留痕（空记录可用快捷键 Alt+L 重新开始）');
  }

  /* ============ 被撤回内容自动弹窗 ============ */
  var pop = document.createElement('div');
  pop.id = 'dslg-pop';
  pop.style.display = 'none';
  pop.innerHTML = `
    <div class="pop-head">⚠️ 检测到回答被安全规则撤回<span class="x" id="dslg-pop-close">×</span></div>
    <div class="pop-body" id="dslg-pop-body"></div>
    <div class="pop-foot">
      <button id="dslg-pop-copy">📋 复制被撤回内容</button>
      <button id="dslg-pop-export">💾 导出TXT</button>
      <button id="dslg-pop-ok">知道了</button>
    </div>`;
  document.documentElement.appendChild(pop);

  var popEntry = null;
  function showWithdrawPopup(entry) {
    popEntry = entry;
    pop.querySelector('#dslg-pop-body').textContent = entry.withdrawnText || entry.text;
    pop.style.display = 'flex';
    updateBadge();
    if (panelOpen) renderActive();
    toast('⚠️ 有回答被安全规则撤回，已拦截显示');
  }
  function hidePop() { pop.style.display = 'none'; }
  pop.querySelector('#dslg-pop-close').onclick = hidePop;
  pop.querySelector('#dslg-pop-ok').onclick = hidePop;
  pop.querySelector('#dslg-pop-copy').onclick = function () {
    if (popEntry) copyText(popEntry.withdrawnText || popEntry.text, '已复制被撤回的内容');
  };
  pop.querySelector('#dslg-pop-export').onclick = function () {
    if (popEntry) download('被撤回内容_' + stamp() + '.txt', buildText(popEntry));
  };

  function download(name, content, mime) {
    var blob = new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  function stamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function copyText(t, ok) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { toast(ok || '已复制'); }, function () { fallback(t, ok); });
    } else fallback(t, ok);
  }
  function fallback(t, ok) {
    var ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(ok || '已复制'); } catch (e) { toast('复制失败'); }
    document.body.removeChild(ta);
  }
  var toastTimer = null;
  function toast(msg, ms) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(17,24,39,.94);color:#fff;padding:10px 22px;border-radius:10px;font-size:14px;z-index:2147483999;font-family:system-ui';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 1800);
  }

  // 纯正文：只取已保存的最长可信文本（不含替换提示与旧版本），供"复制正文"使用
  function entryBody(e) { return e.withdrawnText || e.text || ''; }

  function buildText(e) {
    var s = '【' + e.role + '】' + nowStr(e.firstSeen) +
      (e.role === 'AI' ? (e.withdrawn ? ' [被安全规则撤回-已拦截]' : (e.suspected ? ' [疑似被撤回-已留痕]' : (e.alive ? ' [页面上]' : ' [已消失-已留痕]'))) : '') + '\n' + (e.withdrawnText || e.text);
    if (e.replacementText && e.replacementText !== (e.withdrawnText || e.text)) {
      s += '\n\n— 后续替换/提示文本（正文已另存）—\n' + e.replacementText;
    }
    (e.versions || []).forEach(function (v) {
      s += '\n\n— 被替换前的旧版本 ' + nowStr(v.at) + ' —\n' + v.text;
    });
    return s;
  }

  var listDirty = false, listSig = '';
  function renderList() {
    var list = panel.querySelector('#dslg-list');
    var kw = panel.querySelector('#dslg-search').value.trim();
    var view = visibleEntries().slice().reverse();
    if (kw) view = view.filter(function (e) { return e.text.indexOf(kw) >= 0 || (e.withdrawnText || '').indexOf(kw) >= 0; });
    var onlyWd = document.getElementById('dslg-onlywd');
    var onlyWdOn = !!(onlyWd && onlyWd.checked);
    if (onlyWdOn) view = view.filter(function (e) { return e.withdrawn || e.suspected; });
    // ① 用户正在列表内框选文本时不重绘（否则选区被销毁 → 无法选择性复制）
    var sel = window.getSelection ? window.getSelection() : null;
    if (sel && !sel.isCollapsed && sel.rangeCount &&
        ((sel.anchorNode && list.contains(sel.anchorNode)) || (sel.focusNode && list.contains(sel.focusNode)))) {
      listDirty = true; return;
    }
    // ② 内容未变化则跳过重绘（减少闪烁 / 滚动重置 / 无谓刷新）
    var sig = kw + '|' + (onlyWdOn ? 1 : 0) + '|' + view.map(function (e) {
      return e.id + (e.withdrawn ? 'w' : (e.suspected ? 's' : (e.alive ? 'a' : 'g'))) + e.text.length + (e.expanded ? 1 : 0) +
        (e.replacementText ? e.replacementText.length : 0) + ':' + ((e.versions || []).length);
    }).join(',');
    if (sig === listSig && list.firstChild) { listDirty = false; return; }
    listSig = sig; listDirty = false;
    if (!view.length) {
      list.innerHTML = '<div class="dslg-empty">' + (visibleEntries().length ? '没有匹配的记录' : '还没有捕获到文字。<br>正常与 DeepSeek 对话即可，<br>回答一出现在页面上就会自动留痕。') + '</div>';
      return;
    }
    list.innerHTML = view.map(function (e) {
      var badgeRole = e.role === 'AI'
        ? '<span class="dslg-badge ai">AI回答</span>'
        : '<span class="dslg-badge me">我的提问</span>';
      var state = e.role === 'AI'
        ? (e.withdrawn ? '<span class="dslg-badge gone">⚠️ 被撤回·已拦截</span>'
          : (e.suspected ? '<span class="dslg-badge gone">❓ 疑似撤回·已留痕</span>'
            : (e.alive ? '<span class="dslg-badge live">页面上</span>' : '<span class="dslg-badge gone">已消失·已留痕</span>')))
        : '';
      var regen = e.regenerated ? '<span class="dslg-badge regen">重生成×' + e.regenerated + '</span>' : '';
      var netB = e.net ? '<span class="dslg-badge net">网络全文</span>' : '';
      var preview = e.text.length > 90 ? e.text.slice(0, 90) + '…' : e.text;
      var versions = (e.versions || []).map(function (v) {
        return '<div class="ver">被替换前版本 ' + nowStr(v.at) + '：\n' + esc(v.text) + '</div>';
      }).join('');
      return '<div class="dslg-item ' + (e.role === 'AI' && (e.withdrawn || !e.alive) ? 'dead' : '') + (e.expanded ? ' open' : '') + '" data-id="' + e.id + '">' +
        '<div class="dslg-ih">' + badgeRole + '<span>' + nowStr(e.firstSeen) + '</span>' + state + regen + netB +
        '<span class="sp">' + (e.text.length) + '字</span><span>▸</span></div>' +
        '<div class="dslg-body">' + esc(e.text) + versions + '</div>' +
        '<div class="dslg-acts"><button data-act="copy">复制正文</button><button data-act="copyfull">复制完整记录</button><button data-act="export">导出此条</button><button data-act="del">删除</button></div>' +
        '</div>';
    }).join('');

    list.querySelectorAll('.dslg-item').forEach(function (it) {
      var id = it.getAttribute('data-id');
      it.querySelector('.dslg-ih').onclick = function () {
        var e = getEntry(id); if (!e) return;
        e.expanded = !e.expanded; it.classList.toggle('open');
      };
      it.querySelector('[data-act="copy"]').onclick = function (ev) {
        ev.stopPropagation();
        var e = getEntry(id); if (e) copyText(entryBody(e), '已复制正文（' + entryBody(e).length + ' 字）');
      };
      it.querySelector('[data-act="copyfull"]').onclick = function (ev) {
        ev.stopPropagation();
        var e = getEntry(id); if (e) copyText(buildText(e), '已复制完整记录（含替换/旧版本）');
      };
      it.querySelector('[data-act="export"]').onclick = function (ev) {
        ev.stopPropagation();
        var e = getEntry(id); if (e) download('留痕_' + id + '.txt', buildText(e));
      };
      it.querySelector('[data-act="del"]').onclick = function (ev) {
        ev.stopPropagation();
        entries = entries.filter(function (x) { return x.id !== id; });
        saveNow(); renderActive(); updateBadge();
      };
    });
  }
  // 框选结束后补一次被推迟的渲染
  document.addEventListener('selectionchange', function () {
    if (!listDirty || !panelOpen || activeTab !== 'list') return;
    var sel = window.getSelection ? window.getSelection() : null;
    if (sel && !sel.isCollapsed) return;
    renderList();
  });
  function getEntry(id) {
    for (var i = 0; i < entries.length; i++) if (entries[i].id === id) return entries[i];
    return null;
  }

  function updateBadge() {
    var n = panel.querySelector ? document.getElementById('dslg-count') : null;
    if (!n) return;
    var list = visibleEntries();
    n.textContent = list.length;
    var wd = list.filter(function (e) { return e.role === 'AI' && e.withdrawn; }).length;
    var dead = list.filter(function (e) { return e.role === 'AI' && !e.alive && !e.withdrawn; }).length;
    n.className = (wd || dead) ? 'n dead' : 'n';
    n.title = wd ? ('⚠️ ' + wd + ' 条回答被安全规则撤回，已被拦截保留') : (dead ? ('有 ' + dead + ' 条已从页面消失，文字已留痕') : '');
  }
  updateBadge();

  /* ============ 启动确认与自动展开 ============ */
  try {
    if (!sessionStorage.getItem('dslg_hello')) {
      sessionStorage.setItem('dslg_hello', '1');
      setTimeout(function () { toast('✅ 留痕已启用（网络级捕获）· 点右下角按钮或按 Alt+L', 3200); }, 700);
    }
  } catch (e) {}
  if (S.autoOpen) setTimeout(function () { openDash('home'); }, 900);
  }

  // document-start 下 DOM 尚未就绪，等 DOM 完成后再启动页面层
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootDSLogger);
  } else {
    bootDSLogger();
  }
})();
