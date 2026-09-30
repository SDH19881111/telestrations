// 맞히기 도우미: 글자 카드·객관식 보기, 힌트(글자수·초성·첫 글자·설명), 살아남은 단어
// 화면(DOM)과 Firebase에 의존하지 않는 순수 함수만 둔다 (tests/hints.test.mjs).

export const GUESS_MODES = ['free', 'tiles', 'choice'];
export const DEFAULT_HINTS = 3;
export const DEFAULT_TILES = 12;
export const MAX_TILES = 20;
export const DESC_MAX = 40;

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const isHangul = (ch) => ch >= '가' && ch <= '힣';

/** 초성: '달팽이' → 'ㄷㅍㅇ' (한글이 아닌 글자는 그대로, 띄어쓰기 유지) */
export function chosung(text) {
  return [...text].map((ch) => (isHangul(ch) ? CHO[Math.floor((ch.charCodeAt(0) - 0xac00) / 588)] : ch)).join('');
}

/** 비교·카드용: 띄어쓰기를 뺀 글자 배열 */
export const letters = (text) => [...(text || '').replace(/\s+/g, '')];

/** 글자수: '우주 고양이' → '○○ ○○○ (5글자)' */
export function lengthMask(text) {
  const t = (text || '').trim().replace(/\s+/g, ' ');
  return `${[...t].map((ch) => (ch === ' ' ? ' ' : '○')).join('')} (${letters(t).length}글자)`;
}

/** 같은 입력이면 같은 순서가 나오는 난수 (새로고침해도 카드·보기 순서가 그대로) */
export function seeded(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 추측 차례의 '정답' = 앞사람이 보고 그린 글.
 * r라운드(추측)의 앞 페이지(r-1)가 그림이고, 그 그림의 제시어는 r-2 페이지(짝수 인원 1라운드는 스케치북 제시어).
 */
export function answerFor(book, r) {
  if (!book) return '';
  if (r === 1 && book.word && !(book.pages && book.pages[0] && book.pages[0].type === 'word')) return book.word;
  const p = book.pages && book.pages[r - 2];
  return p && !p.hidden && p.type !== 'draw' ? (p.content || '').trim() : '';
}

/**
 * 오답 카드·보기용 단어 순서: 선생님 목록(primary)을 섞어 먼저, 모자라면 기본 제시어(fallback)를 섞어 뒤에.
 * 정답과 같은 단어는 뺀다.
 */
function decoyWords(answer, primary, fallback, rand) {
  const key = letters(answer).join('');
  const clean = (list) => [...new Set((list || []).map((w) => (w || '').trim()).filter((w) => w && letters(w).join('') !== key))];
  const p = clean(primary);
  return shuffle(p, rand).concat(shuffle(clean(fallback).filter((w) => !p.includes(w)), rand));
}

/** 글자 카드: 정답 글자 + 다른 제시어들의 글자로 count장 (정답 글자는 모두 들어 있음) */
export function tileSet(answer, primary, fallback, count, seedText) {
  const ans = letters(answer);
  const rand = seeded(`tiles:${seedText}`);
  const total = Math.min(MAX_TILES, Math.max(count || DEFAULT_TILES, ans.length + 4));
  const decoys = [];
  const seen = new Set(ans);
  // 선생님 목록 단어의 글자를 먼저 쓴다 → 그럴듯한 오답 조합이 생기게
  for (const w of decoyWords(answer, primary, fallback, rand)) {
    for (const ch of letters(w)) {
      if (decoys.length >= total - ans.length) break;
      if (!seen.has(ch) && isHangul(ch)) { seen.add(ch); decoys.push(ch); }
    }
    if (decoys.length >= total - ans.length) break;
  }
  // 그래도 모자라면 자주 쓰는 글자로
  for (const ch of '가나다라마바사아자차카타파하고기이우소무리수'.split('')) {
    if (decoys.length >= total - ans.length) break;
    if (!seen.has(ch)) { seen.add(ch); decoys.push(ch); }
  }
  return shuffle([...ans, ...decoys], rand);
}

/** 객관식: 정답 + 다른 제시어 3개 (선생님 목록에서 먼저) */
export function choiceSet(answer, primary, fallback, seedText) {
  const rand = seeded(`choice:${seedText}`);
  const picks = decoyWords(answer, primary, fallback, rand).slice(0, 3);
  return shuffle([answer.trim(), ...picks], rand);
}

/** 객관식 '두 개 지우기' 힌트로 지울 오답 두 개 */
export function fiftyFifty(choices, answer, seedText) {
  const rand = seeded(`fifty:${seedText}`);
  return shuffle(choices.filter((c) => c !== answer.trim()), rand).slice(0, 2);
}

/** 방식별 힌트 순서. 설명이 없으면 설명 단계는 뺀다. */
export function hintLadder(mode, hasDesc) {
  const base = mode === 'tiles' ? ['first', 'cho'] : mode === 'choice' ? ['fifty'] : ['len', 'cho'];
  return hasDesc ? [...base, 'desc'] : base;
}

export const HINT_LABEL = { len: '글자수', cho: '초성', first: '첫 글자', desc: '설명', fifty: '보기 두 개 지우기' };

export function hintText(kind, answer, desc) {
  if (kind === 'len') return `글자수: ${lengthMask(answer)}`;
  if (kind === 'cho') return `초성: ${chosung(answer)}`;
  if (kind === 'first') return `첫 글자: ${letters(answer)[0] || ''}`;
  if (kind === 'desc') return `설명: ${desc}`;
  if (kind === 'fifty') return '틀린 보기 두 개를 지웠어요.';
  return '';
}

/** Firebase 키에 못 쓰는 글자(. # $ [ ] /)를 바꾼 설명 저장 키 */
export const descKey = (word) => word.trim().replace(/[.#$[\]/]/g, '_');

/**
 * 선생님 제시어 입력 해석. 한 줄에 '단어 : 설명' 또는 '단어' (설명 없는 줄은 쉼표로 여러 개도 가능).
 * → { words: [...], desc: { key: 설명 } }
 */
export function parseWordList(text, wordMax = 20) {
  const words = [];
  const desc = {};
  for (const line of (text || '').split('\n')) {
    const i = line.search(/[:：]/);
    if (i >= 0) {
      const w = line.slice(0, i).trim().slice(0, wordMax);
      const d = line.slice(i + 1).trim().slice(0, DESC_MAX);
      if (!w) continue;
      words.push(w);
      if (d) desc[descKey(w)] = d;
    } else {
      for (const part of line.split(',')) {
        const w = part.trim().slice(0, wordMax);
        if (w) words.push(w);
      }
    }
  }
  const unique = [...new Set(words)].slice(0, 500);
  return { words: unique, desc };
}

/** 선생님 입력칸에 다시 채울 글 */
export function formatWordList(words, desc = {}) {
  return (words || []).map((w) => (desc[descKey(w)] ? `${w} : ${desc[descKey(w)]}` : w)).join('\n');
}

/** 스케치북의 첫 제시어가 마지막 추측까지 그대로 이어졌는지 (띄어쓰기 무시) */
export function survived(book, N) {
  if (!book || !book.pages) return false;
  const first = N % 2 === 0 ? book.word : book.pages[0] && book.pages[0].content;
  const last = book.pages[N - 1] && book.pages[N - 1].content;
  const norm = (t) => letters(t).join('');
  return !!first && !!last && norm(first) === norm(last);
}
