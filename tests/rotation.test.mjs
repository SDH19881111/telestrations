// 스케치북 로테이션·페이지 종류 규칙 검사: node tests/rotation.test.mjs
// (game.js는 Firebase CDN을 import하므로 규칙 함수만 복사하지 않고 소스에서 추출해 검사한다)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../js/game.js', import.meta.url), 'utf8');
const pick = (name) => src.match(new RegExp(`export function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0].replace('export ', '');
const { pageType, bookFor, writerIndex } = new Function(
  `${pick('pageType')}\n${pick('bookFor')}\n${pick('writerIndex')}\nreturn { pageType, bookFor, writerIndex };`,
)();

for (let N = 4; N <= 12; N++) {
  // 마지막 페이지는 항상 추측
  assert.equal(pageType(N - 1, N), 'guess', `N=${N} 마지막 페이지`);
  // 그림과 추측이 번갈아 나온다
  for (let r = 1; r < N; r++) assert.notEqual(pageType(r, N), pageType(r - 1, N), `N=${N} r=${r}`);
  assert.equal(pageType(0, N), N % 2 === 0 ? 'draw' : 'word');

  for (let r = 0; r < N; r++) {
    // 매 라운드 모든 스케치북이 정확히 한 사람에게 배정된다
    const books = new Set();
    for (let i = 0; i < N; i++) books.add(bookFor(i, r, N));
    assert.equal(books.size, N, `N=${N} r=${r} 배정 중복`);
    for (let b = 0; b < N; b++) assert.equal(bookFor(writerIndex(b, r, N), r, N), b);
  }
  for (let b = 0; b < N; b++) {
    // 0라운드는 주인이, 마지막은 주인 바로 앞 순번이 작성
    assert.equal(writerIndex(b, 0, N), b);
    assert.equal(writerIndex(b, N - 1, N), (b - 1 + N) % N);
    // 한 스케치북에 같은 사람이 두 번 쓰지 않는다
    const writers = new Set();
    for (let r = 0; r < N; r++) writers.add(writerIndex(b, r, N));
    assert.equal(writers.size, N);
  }
}
console.log('rotation tests passed (N=4..12)');
