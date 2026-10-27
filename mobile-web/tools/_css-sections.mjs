import fs from 'node:fs';

const raw = fs.readFileSync('mobile-web/probe-output/dy4k.css', 'utf8').trim();
// 文件是 CDP 返回的字符串字面量，去掉首尾引号
const css = raw.replace(/^"|"$/g, '').replace(/\\n/g, '\n').replace(/\\"/g, '"');
const parts = css.split(/(\/\*\*? --- [^*]*--- \*\/)/).filter(Boolean);
let idx = 0;
let buf = '';
const sections = [];
for (const p of parts) {
  if (p.startsWith('/*')) {
    if (buf.trim()) sections.push({ title: '(head)', css: buf });
    buf = '';
    sections.push({ title: p.replace(/[/*-]/g, '').trim().slice(0, 40), css: '' });
  } else {
    if (sections.length) sections[sections.length - 1].css += p;
    else buf += p;
  }
}
if (buf.trim()) sections.unshift({ title: '(head)', css: buf });
sections.forEach((s, i) => {
  console.log('[' + i + '] ' + s.title.padEnd(42) + ' ' + s.css.split('\n').length + ' 行');
});
fs.writeFileSync('mobile-web/probe-output/dy4k-sections.json', JSON.stringify(sections, null, 1), 'utf8');
console.log('sections:', sections.length);
