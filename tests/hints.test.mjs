// 맞히기 도우미(글자 카드·객관식·힌트) 규칙 테스트
import assert from 'node:assert/strict';
import {
  chosung, lengthMask, letters, tileSet, choiceSet, fiftyFifty, hintLadder, hintText,
  answerFor, parseWordList, formatWordList, descKey, survived,
} from '../js/hints.js';

assert.equal(chosung('달팽이'), 'ㄷㅍㅇ');
assert.equal(chosung('우주 고양이'), 'ㅇㅈ ㄱㅇㅇ');
assert.equal(chosung('TV 리모컨'), 'TV ㄹㅁㅋ');
assert.equal(lengthMask('달팽이'), '○○○ (3글자)');
assert.equal(lengthMask(' 우주  고양이 '), '○○ ○○○ (5글자)');

const pool = ['사과', '기차', '달팽이', '연필', '우산', '로봇', '입춘', '우수', '경칩'];
for (const [ans, count] of [['달팽이', 12], ['우주 고양이', 12], ['해', 8], ['아주아주긴단어입니다요', 12]]) {
  const t = tileSet(ans, pool, [], count, 'seed1');
  assert.equal(t.length, Math.min(20, Math.max(count, letters(ans).length + 4)), `tile count for ${ans}`);
  // 정답 글자가 모두 (중복 포함) 들어 있다
  const bag = [...t];
  for (const ch of letters(ans)) { const i = bag.indexOf(ch); assert.ok(i >= 0, `${ch} missing for ${ans}`); bag.splice(i, 1); }
  assert.deepEqual(tileSet(ans, pool, [], count, 'seed1'), t, 'same seed → same tiles');
}
assert.notDeepEqual(tileSet('달팽이', pool, [], 12, 'a'), tileSet('달팽이', pool, [], 12, 'b'));
// 선생님 목록 글자가 기본 제시어보다 먼저 쓰인다
{
  const classList = ['사과', '기차', '달팽이', '연필', '우산'];
  const t = tileSet('달팽이', classList, ['코끼리', '햄버거', '비행기', '자동차', '수박'], 12, 's');
  for (const ch of '사과기차연필우산') assert.ok(t.includes(ch), `class letter ${ch} missing`);
  const c = choiceSet('달팽이', classList, ['코끼리', '햄버거'], 's');
  assert.ok(c.every((w) => classList.includes(w)), `decoys not from class list: ${c}`);
  assert.equal(choiceSet('달팽이', ['달팽이', '사과'], ['코끼리', '햄버거'], 's').length, 4, 'fallback words fill choices');
}

const c = choiceSet('달팽이', pool, [], 's');
assert.equal(c.length, 4);
assert.ok(c.includes('달팽이'));
assert.equal(new Set(c).size, 4);
assert.deepEqual(choiceSet('달팽이', pool, [], 's'), c);
const gone = fiftyFifty(c, '달팽이', 's');
assert.equal(gone.length, 2);
assert.ok(!gone.includes('달팽이'));
assert.ok(choiceSet('없는말', ['없는말'], [], 's').length === 1, 'no decoys when pool is only the answer');

assert.deepEqual(hintLadder('free', true), ['len', 'cho', 'desc']);
assert.deepEqual(hintLadder('tiles', false), ['first', 'cho']);
assert.deepEqual(hintLadder('choice', true), ['fifty', 'desc']);
assert.equal(hintText('first', '달팽이'), '첫 글자: 달');
assert.equal(hintText('desc', '달팽이', '집을 지고 다녀요'), '설명: 집을 지고 다녀요');

// 정답 찾기: 짝수 인원 (0 그림, 1 추측, 2 그림, 3 추측)
const even = { word: '사과', pages: { 0: { type: 'draw', content: 'data:image/webp' }, 1: { type: 'guess', content: '토마토' }, 2: { type: 'draw', content: 'data:x' } } };
assert.equal(answerFor(even, 1), '사과');
assert.equal(answerFor(even, 3), '토마토');
// 홀수 인원 (0 제시어, 1 그림, 2 추측)
const odd = { word: undefined, pages: { 0: { type: 'word', content: '기차' }, 1: { type: 'draw', content: 'data:x' } } };
assert.equal(answerFor(odd, 2), '기차');
// 가려진 글은 힌트 없음
assert.equal(answerFor({ pages: { 1: { type: 'guess', content: '', hidden: true } } }, 3), '');

const parsed = parseWordList('달팽이 : 등에 집을 지고 다녀요\n사과, 기차\n\n연필：글씨를 써요\n사과');
assert.deepEqual(parsed.words, ['달팽이', '사과', '기차', '연필']);
assert.deepEqual(parsed.desc, { 달팽이: '등에 집을 지고 다녀요', 연필: '글씨를 써요' });
assert.equal(formatWordList(parsed.words, parsed.desc), '달팽이 : 등에 집을 지고 다녀요\n사과\n기차\n연필 : 글씨를 써요');
assert.equal(descKey('a.b/c'), 'a_b_c');

assert.equal(survived({ word: '사과', pages: { 3: { content: '사 과' } } }, 4), true);
assert.equal(survived({ word: '사과', pages: { 3: { content: '토마토' } } }, 4), false);
assert.equal(survived({ pages: { 0: { content: '기차' }, 2: { content: '기차' } } }, 3), true);

console.log('hints tests passed');
