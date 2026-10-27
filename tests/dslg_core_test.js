// 核心逻辑模拟测试（内容无关：全部使用占位文本，不含任何真实聊天内容）
// 用法：node tests/dslg_core_test.js
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  path.join(__dirname, '..', 'userscript', 'deepseek-text-logger.user.js'),
  path.join(__dirname, '..', 'DeepSeek文字留痕.user.js'),
  path.join(__dirname, '..', 'userscript', 'DeepSeek文字留痕.user.js'),
];
const SRC = CANDIDATES.find(p => fs.existsSync(p));
if (!SRC) { console.error('userscript not found'); process.exit(1); }

const src = fs.readFileSync(SRC, 'utf8');
const m = src.match(/\/\*__DSLG_CORE_START__\*\/([\s\S]*?)\/\*__DSLG_CORE_END__\*\//);
if (!m) { console.error('CORE section not found in user script'); process.exit(1); }
const window = {};
const CORE = new Function('window', m[1] + '\n;return DSLG_CORE;')(window);

let pass = 0, fail = 0;
function t(name, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); cond ? pass++ : fail++; }

const LONG = '长'.repeat(8000);                             // 占位长正文（8000 字）
const SHORT = '你好，这个问题我暂时无法回答，让我们换个话题再聊聊吧。'; // 占位短替换（53 字）

// 场景1：完整长回复（快照流）被短替换包替换 → 恢复长正文，短包留档
{
  const ch = CORE.newChannel();
  CORE.feedChannel(ch, LONG.slice(0, 4000));
  CORE.feedChannel(ch, LONG);
  CORE.feedChannel(ch, SHORT);
  const r = CORE.pickChannel(ch);
  t('1 长回复被短替换：仍恢复完整长正文', r.best === LONG);
  t('1 短替换包被单独留档', r.replaced.some(s => s.indexOf('暂时无法回答') >= 0));
}

// 场景2：DOM 层"短文本不得覆盖长正文"；recoveryText 取最长
{
  const e = { text: '', versions: [] };
  CORE.applyDomText(e, LONG, 1);
  const changed = CORE.applyDomText(e, SHORT, 2);
  t('2 短文本不覆盖长正文（text 保持 8000）', e.text === LONG && changed === false);
  t('2 当前页面文字与替换文本另存', e.currentText === SHORT && e.replacementText === SHORT);
  t('2 recoveryText 取最长 = 长正文', CORE.recoveryText(e) === LONG);
}

// 场景3：网络层"增量包 + 完整包" → 不重复拼接
{
  const ch = CORE.newChannel();
  CORE.feedChannel(ch, '你好');
  CORE.feedChannel(ch, '，世界');
  const full = '你好，世界！这是增量输出的完整句子。';
  CORE.feedChannel(ch, full);
  const r = CORE.pickChannel(ch);
  t('3 增量+完整包：无重复拼接', r.best === full);
}

// 场景4：纯增量流（逐字）正确累计，不被误判为替换
{
  const ch = CORE.newChannel();
  ['一', '二', '三', '四'].forEach(s => CORE.feedChannel(ch, s));
  const r = CORE.pickChannel(ch);
  t('4 纯增量流正确累计', r.best === '一二三四');
}

// 场景5：entry.text 被短文本覆盖后，网络层仍能用"历史最长文本"配对
{
  const e = { text: '', maxDomText: '', currentText: '', maxNetText: '', versions: [] };
  CORE.applyDomText(e, 'A'.repeat(300), 1);
  CORE.applyDomText(e, '短提示', 2);
  t('5 配对用历史最长文本（300）', CORE.entryLongestText(e).length === 300);
}

// 场景6：疑似撤回状态下，正文仍保留
{
  const e = { text: '', versions: [] };
  CORE.applyDomText(e, 'B'.repeat(500), 1);
  e.suspected = true;
  t('6 疑似撤回仍保留正文（500）', CORE.recoveryText(e).length === 500 && e.text.length === 500);
}

// 场景7（静态检查）：关键防线都在源码里
{
  t('7 面板/弹窗/悬浮钮排除在扫描之外', src.includes("closest('#dslg-panel,#dslg-pop,#dslg-fab')"));
  t('7 下标兜底仅限空槽位（禁止顶替长正文）', src.includes("(slots[p.idx].text || '').length < 12"));
  t('7 网络配对使用 entryLongestText', src.includes('prefMatch(cap.text, DSLG_CORE.entryLongestText(e))'));
  t('7 撤回取快照 recoveryText', src.includes('DSLG_CORE.longer(DSLG_CORE.recoveryText(entry), oldText'));
  t('7 列表重绘有框选保护', src.includes('sel.isCollapsed') && src.includes('list.contains(sel.anchorNode)'));
  t('7 复制正文只取 entryBody（不含替换/旧版本）', src.includes('copyText(entryBody(e)'));
  t('7 复制全部只取正文', src.includes('visibleEntries().map(entryBody)'));
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
