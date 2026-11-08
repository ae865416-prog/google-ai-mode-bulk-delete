/**
 * 從 OpenCC 的 STCharacters.txt 產生 content/s2t.js
 * 只留「1 個簡體字 → 1 個繁體字」的對照，存成兩兩一組的字串，體積最小。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(process.env.TEMP, 'st.txt');
const OUT = path.join(__dirname, '..', 'content', 's2t.js');

const text = fs.readFileSync(SRC, 'utf8');
const map = new Map();

for (const raw of text.split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const tab = line.indexOf('\t');
  if (tab < 0) continue;
  const key = line.slice(0, tab).trim();
  const vals = line.slice(tab + 1).trim().split(/\s+/).filter(Boolean);
  if (!vals.length) continue;

  const k = Array.from(key);
  const v = Array.from(vals[0]);
  if (k.length !== 1 || v.length !== 1) continue;
  if (k[0] === v[0]) continue;
  if (map.has(k[0])) continue;
  map.set(k[0], v[0]);
}

let pairs = '';
for (const [k, v] of map) pairs += k + v;

const js = `/*!
 * 簡體 → 繁體 單字對照表
 * 資料來源：OpenCC 的 STCharacters.txt（Apache-2.0，https://github.com/BYVoid/OpenCC）
 * 只取「一對一」的對應，並在執行時先套用少量常用詞的例外（例如 头发 → 頭髮）。
 * 用途：匯出的文字不要混到簡體字。
 */
(() => {
  'use strict';
  const PAIRS = ${JSON.stringify(pairs)};
  const CHARS = Array.from(PAIRS);
  const map = new Map();
  for (let i = 0; i + 1 < CHARS.length; i += 2) {
    if (!map.has(CHARS[i])) map.set(CHARS[i], CHARS[i + 1]);
  }

  // 單字轉換會出錯的常用詞，先整詞換掉
  const PHRASES = [
    ['头发', '頭髮'], ['理发', '理髮'], ['发型', '髮型'], ['短发', '短髮'], ['长发', '長髮'],
    ['白发', '白髮'], ['发丝', '髮絲'], ['假发', '假髮'], ['发廊', '髮廊'], ['发际', '髮際'],
    ['干货', '乾貨'], ['干燥', '乾燥'], ['干杯', '乾杯'], ['干果', '乾果'], ['饼干', '餅乾'],
    ['干旱', '乾旱'], ['干洗', '乾洗'], ['豆干', '豆乾'], ['笋干', '筍乾'],
    ['面条', '麵條'], ['方便面', '方便麵'], ['拉面', '拉麵'], ['面包', '麵包'],
  ];

  // 轉完之後再修成台灣用字
  const TW_FIX = { '爲': '為', '喫': '吃', '裏': '裡', '衞': '衛', '敎': '教', '淸': '清', '麪': '麵', '纔': '才', '着': '著', '竈': '灶', '窰': '窯', '疎': '疏', '敍': '敘', '囘': '回' };

  function convert(str) {
    let s = String(str == null ? '' : str);
    if (!s) return s;
    for (const [a, b] of PHRASES) {
      if (s.indexOf(a) >= 0) s = s.split(a).join(b);
    }
    let out = '';
    for (const ch of s) {
      const t = map.get(ch) || ch;
      out += TW_FIX[t] || t;
    }
    return out;
  }

  window.__AMB_S2T__ = { size: map.size, convert };
})();
`;

fs.writeFileSync(OUT, js, 'utf8');
console.log('entries:', map.size, '→', OUT, Math.round(Buffer.byteLength(js) / 1024) + ' KB');
