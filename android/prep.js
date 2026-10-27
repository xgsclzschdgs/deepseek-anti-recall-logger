const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.env.DSLG_USERSCRIPT || path.join(ROOT, 'userscript', 'deepseek-text-logger.user.js');
const OUT_DIR = path.join(__dirname, 'app', 'assets');

let code = fs.readFileSync(SRC, 'utf8');
code = code.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\r?\n/, '');
code = code.replace(/^\s+/, '');
new Function(code); // 语法自检

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'ds_logger.js'), code, 'utf8');

const m = code.match(/\/\*__NETCAP_START__\*\/([\s\S]*?)\/\*__NETCAP_END__\*\//);
if (!m) throw new Error('NETCAP markers not found');
fs.writeFileSync(path.join(OUT_DIR, 'ds_netcap.js'), m[1], 'utf8');

console.log('prep ok: logger', code.length, 'netcap', m[1].length);
