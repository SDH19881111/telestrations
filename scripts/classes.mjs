// 수업 데이터(data/classes.json) ↔ Firebase /classes 변환·검증
//   node scripts/classes.mjs sync   <out.json>        : data/classes.json → Firebase 다중 경로 업데이트 JSON
//   node scripts/classes.mjs export <firebase.json>   : Firebase /classes 덤프 → data/classes.json
//   node scripts/classes.mjs list                      : data/classes.json 목록 출력
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../data/classes.json', import.meta.url);
// 저장소가 관리하는 필드. open·openedAt·createdAt 같은 진행 상태는 Firebase에만 둔다.
const FIELDS = ['groups', 'leaderStart', 'settings', 'words'];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '') || 'null');

function validate(code, c) {
  const err = (msg) => { throw new Error(`수업 '${code}': ${msg}`); };
  if (code.length < 2 || code.length > 10 || code.includes('-') || /[.#$\[\]\/]/.test(code)) err('코드는 2~10자, - . # $ [ ] / 없이');
  if (!Number.isInteger(c.groups) || c.groups < 1 || c.groups > 8) err('groups는 1~8');
  if (typeof c.leaderStart !== 'boolean') err('leaderStart는 true/false');
  const s = c.settings || {};
  if (!(s.drawSec >= 15 && s.drawSec <= 180)) err('settings.drawSec는 15~180');
  if (!(s.guessSec >= 10 && s.guessSec <= 120)) err('settings.guessSec는 10~120');
  if (!Array.isArray(c.words)) err('words는 배열');
  for (const w of c.words) if (typeof w !== 'string' || !w.trim() || w.length > 20) err(`제시어 '${w}'는 1~20자`);
}

function pick(c) {
  return {
    groups: c.groups ?? 2,
    leaderStart: c.leaderStart ?? true,
    settings: { drawSec: c.settings?.drawSec ?? 60, guessSec: c.settings?.guessSec ?? 30 },
    words: c.words ?? [],
  };
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'sync') {
  const classes = readJson(FILE);
  const patch = {};
  for (const [code, c] of Object.entries(classes)) {
    validate(code, c);
    for (const f of FIELDS) patch[`${code}/${f}`] = f === 'words' && !c.words.length ? null : c[f];
  }
  writeFileSync(arg, JSON.stringify(patch));
  console.log(`수업 ${Object.keys(classes).length}개 반영 준비: ${Object.keys(classes).join(', ')}`);
} else if (cmd === 'export') {
  const remote = readJson(arg) || {};
  const out = {};
  for (const code of Object.keys(remote).sort()) out[code] = pick(remote[code]);
  writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n');
  console.log(`수업 ${Object.keys(out).length}개 저장: ${Object.keys(out).join(', ')}`);
} else if (cmd === 'list') {
  for (const [code, c] of Object.entries(readJson(FILE))) {
    console.log(`${code}\t모둠 ${c.groups}\t그리기 ${c.settings.drawSec}초/추측 ${c.settings.guessSec}초\t제시어 ${c.words.length || '기본'}${c.words.length ? '개' : ''}`);
  }
} else {
  console.error('사용법: node scripts/classes.mjs sync <out.json> | export <firebase.json> | list');
  process.exit(1);
}
