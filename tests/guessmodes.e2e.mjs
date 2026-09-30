// 맞히기 방식·힌트 E2E (에뮬레이터 필요)
// 1) 선생님: AI 설명 채우기 (Gemini 응답은 가짜로 대신함) — 정답이 드러나는 설명은 빠짐
// 2) 글자 카드: 카드 수·칸 수, 힌트 3단계(첫 글자→초성→설명), 카드로 완성해 제출, 선생님 화면 💡
// 3) 모두 정답 → 결과에 🏆 끝까지 살아남은 단어
// 4) 객관식: 보기 4개, '보기 두 개 지우기' 힌트, 고르면 제출
// 5) 자유 입력: 글자수·초성 힌트, 힌트 개수 한도
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:5000';
const FB = new URL('../node_modules/firebase/', import.meta.url);
const SHOTS = process.env.SHOTS || 'tests/shots';
const CLASS = 'GM' + Math.floor(Math.random() * 9000 + 1000);
const ROOM = `${CLASS}-1`;
const WORDS = ['사과', '기차', '달팽이', '연필', '우산', '로봇', '무지개', '고양이'];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-proxy-server'] });
const errors = [];
const aiCalls = [];

async function newCtx(name, mobile = false) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1200, height: 900 } });
  await ctx.route(/https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/(.*)$/, (route) => {
    route.fulfill({ contentType: 'application/javascript', body: readFileSync(new URL(route.request().url().split('/').pop(), FB)) });
  });
  // 가짜 Gemini: 모델 목록, 예전 모델(2.5)은 404, 받은 단어마다 설명 (기차는 정답이 드러나는 설명)
  await ctx.route(/generativelanguage\.googleapis\.com/, (route) => {
    aiCalls.push(route.request().url().replace(/^.*\/v1beta\//, ''));
    const req = route.request();
    assert.equal(req.headers()['x-goog-api-key'], 'AQ.test-key');
    if (req.method() === 'GET') {
      const models = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-3.9-flash-preview', 'gemini-3.8-flash-image']
        .map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] }));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ models }) });
    }
    if (req.url().includes('gemini-2.5-flash')) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 404, message: 'This model is no longer available to new users.' } }) });
    }
    const words = JSON.parse(req.postDataJSON().contents[0].parts[0].text.split('단어: ')[1]);
    const out = {};
    for (const w of words) out[w] = w === '기차' ? '기차는 길어요' : `${w.length}글자짜리 물건이에요`;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }) });
  });
  return { name, ctx };
}
async function openPage(p, path) {
  const page = await p.ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${p.name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${p.name}] pageerror ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${ORIGIN}/${path}`);
  p.page = page;
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 20000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return; await sleep(200); }
  throw new Error('timeout: ' + label);
}
async function screen(p) {
  for (const s of ['screen-word', 'screen-draw', 'screen-guess', 'waiting', 'screen-result', 'screen-lobby', 'screen-home']) {
    if (await p.page.locator('#' + s).isVisible()) return s;
  }
  return 'none';
}
const all = (pred, label, timeout = 10000) => until(async () => (await Promise.all(kids.map(pred))).every(Boolean), timeout, label);
const roomData = () => teacher.page.evaluate(async (id) => {
  const fb = await import('./js/firebase.js');
  return (await fb.get(fb.roomRef(id))).val();
}, ROOM);
const uidOf = (k) => k.page.evaluate(async () => (await import('./js/firebase.js')).auth.currentUser.uid);

/** 3명: 0 제시어 → 1 그림 → 2 추측. 이 학생이 맞힐 정답 (앞앞 페이지의 제시어) */
async function answerOf(k) {
  const room = await roomData();
  const i = room.order.indexOf(await uidOf(k));
  const b = (((i - 2) % 3) + 3) % 3;
  return room.books[b].pages[0].content;
}

async function playToGuess() {
  await all(async (k) => (await screen(k)) === 'screen-word', 'word round');
  for (const k of kids) await k.page.locator('#word-screen-choices button').first().click();
  await all(async (k) => (await screen(k)) === 'screen-draw', 'draw round');
  for (const k of kids) {
    const box = await k.page.locator('#canvas').boundingBox();
    await k.page.mouse.move(box.x + 40, box.y + 40);
    await k.page.mouse.down();
    await k.page.mouse.move(box.x + 200, box.y + 160, { steps: 5 });
    await k.page.mouse.up();
    await k.page.click('#draw-submit');
  }
  await all(async (k) => (await screen(k)) === 'screen-guess', 'guess round');
}

async function nextGame(mode, hints) {
  await teacher.page.locator('.t-room [data-act="lobby"]').click();
  await all(async (k) => (await screen(k)) === 'screen-lobby', 'lobby');
  await teacher.page.selectOption('#t-mode', mode);
  if (hints !== undefined) await teacher.page.selectOption('#t-hints', String(hints));
  await teacher.page.click('#t-start-all');
}

// ---------- 선생님 ----------
const teacher = await openPage(await newCtx('선생님'), 'teacher.html?emulator=1');
await teacher.page.fill('#t-code', CLASS);
await teacher.page.fill('#t-pass', 'abcd1234');
await teacher.page.click('#t-login-btn');
await teacher.page.locator('#t-dash').waitFor({ state: 'visible' });
await teacher.page.selectOption('#t-groups', '1');
await teacher.page.selectOption('#t-draw', '30');
await teacher.page.selectOption('#t-guess', '30');
assert.equal(await teacher.page.inputValue('#t-mode'), 'free');
assert.equal(await teacher.page.inputValue('#t-hints'), '3');
assert.equal(await teacher.page.inputValue('#t-tiles'), '12');
// 설명 하나는 직접, 나머지는 AI로
await teacher.page.fill('#t-words', ['달팽이 : 등에 집을 지고 느리게 다녀요', ...WORDS.filter((w) => w !== '달팽이')].join('\n'));

// 1) AI 설명
await teacher.page.locator('.ai-box summary').click();
assert.equal(await teacher.page.inputValue('#t-ai-model'), '', 'model should default to auto');
await teacher.page.fill('#t-ai-key', 'AQ.test-key');
// 예전 기본 모델을 적어 두었어도(404) 자동으로 쓸 수 있는 모델로 바꿔 다시 시도한다
await teacher.page.fill('#t-ai-model', 'gemini-2.5-flash');
await teacher.page.click('#t-ai-fill');
await until(async () => (await teacher.page.locator('#t-ai-status').textContent()).includes('채웠어요'), 10000, 'ai fill');
const aiStatus = await teacher.page.locator('#t-ai-status').textContent();
assert.ok(aiStatus.includes('6개 채웠어요') && aiStatus.includes('1개는 뺐어요') && aiStatus.includes('모델: gemini-3.8-flash'), aiStatus);
const wordsText = await teacher.page.inputValue('#t-words');
assert.ok(wordsText.includes('달팽이 : 등에 집을 지고 느리게 다녀요'), 'manual desc overwritten');
assert.ok(wordsText.includes('사과 : 2글자짜리 물건이에요'), wordsText);
assert.ok(/^기차$/m.test(wordsText), 'leaking desc kept');
assert.deepEqual(aiCalls, ['models/gemini-2.5-flash:generateContent', 'models?pageSize=1000', 'models/gemini-3.8-flash:generateContent']);
assert.equal(await teacher.page.evaluate(() => localStorage.getItem('tele.teacher.aiKey')), 'AQ.test-key');
// 새로고침하면 저장된 예전 기본값은 '자동'으로 바뀐다
await teacher.page.reload();
await teacher.page.locator('#t-dash').waitFor({ state: 'visible' });
assert.equal(await teacher.page.inputValue('#t-ai-model'), '', 'old default model not migrated to auto');
console.log('AI fill:', aiStatus);
// 빠진 설명은 선생님이 직접 채운다
await teacher.page.fill('#t-words', wordsText.replace(/^기차$/m, '기차 : 칙칙폭폭 선로 위를 달려요'));
assert.ok((await teacher.page.locator('#t-words-count').textContent()).includes('설명 8개'));

// 2) 글자 카드
await teacher.page.selectOption('#t-mode', 'tiles');
await until(async () => (await teacher.page.locator('#t-save-status').textContent()).includes('저장됨'), 5000, 'saved');
{
  const cls = await teacher.page.evaluate(async (c) => {
    const fb = await import('./js/firebase.js');
    return (await fb.get(fb.ref(fb.db, `classes/${c}`))).val();
  }, CLASS);
  assert.equal(cls.settings.guessMode, 'tiles');
  assert.equal(cls.desc['달팽이'], '등에 집을 지고 느리게 다녀요');
  assert.equal(cls.words.length, WORDS.length);
}
await teacher.page.click('#t-open');
await until(async () => (await teacher.page.locator('.t-room').count()) === 1, 10000, 'room opened');

const kids = [];
for (let i = 0; i < 3; i++) {
  const k = await openPage(await newCtx(`학생${i}`, i === 0), '?emulator=1');
  await k.page.fill('#home-name', `학생${i}`);
  await k.page.fill('#home-code', CLASS);
  await k.page.click('#btn-join');
  await k.page.locator('#group-list button', { hasText: '1모둠' }).click();
  await k.page.locator('#screen-lobby').waitFor({ state: 'visible' });
  kids.push(k);
}
const [k0, k1, k2] = kids;
await teacher.page.click('#t-start-all');
await playToGuess();

{
  const ans = await answerOf(k0);
  assert.equal(await k0.page.locator('#guess-tiles').isVisible(), true);
  assert.equal(await k0.page.locator('#guess-input').isVisible(), false);
  assert.equal(await k0.page.locator('#tile-pool .tile').count(), 12);
  assert.equal(await k0.page.locator('#tile-slots .tile-slot').count(), [...ans].length);
  assert.ok((await k0.page.locator('#hint-btn').textContent()).includes('첫 글자 힌트 보기 (남은 힌트 3개)'));
  for (let n = 1; n <= 3; n++) {
    await k0.page.click('#hint-btn');
    await until(async () => (await k0.page.locator('#hint-list li').count()) === n, 5000, `hint ${n}`);
  }
  const hints = await k0.page.locator('#hint-list li').allTextContents();
  assert.equal(hints[0], `첫 글자: ${ans[0]}`);
  assert.ok(hints[1].startsWith('초성: '));
  assert.ok(hints[2].startsWith('설명: '), hints[2]);
  assert.equal(await k0.page.locator('#hint-btn').isDisabled(), true);
  await k0.page.screenshot({ path: `${SHOTS}/guess-tiles.png`, fullPage: true });
  console.log('tiles:', ans, '| hints:', hints.join(' / '));
}

// 모두 카드로 정답 완성 (잘못 누른 카드 지우기도 한 번)
for (const k of kids) {
  const ans = await answerOf(k);
  const wrong = k.page.locator('#tile-pool .tile:not(:disabled)').filter({ hasNotText: new RegExp(`^[${ans}]$`) }).first();
  await wrong.click();
  await k.page.click('#tile-back');
  for (const ch of ans) await k.page.locator('#tile-pool .tile:not(:disabled)', { hasText: new RegExp(`^${ch}$`) }).first().click();
  assert.equal(await k.page.locator('#tile-submit').isEnabled(), true);
  await k.page.click('#tile-submit');
}
await all(async (k) => (await screen(k)) === 'screen-result', 'results (tiles)');
{
  const room = await roomData();
  const mine = Object.values(room.books).map((b) => b.pages[2]);
  assert.ok(mine.every((p, i) => p.content === room.books[i].pages[0].content), 'tile answers wrong');
  assert.equal(mine.filter((p) => p.hint === 3).length, 1, 'hint level not recorded on page');
  // 한 명이 3개를 다 썼으니 다음 판 전까지 0개
  const total = Object.values(room.hintUse[await uidOf(k0)]).reduce((a, b) => a + b, 0);
  assert.equal(total, 3);
}
// 3) 🏆 (결과는 각자 자기 스케치북 마지막 장부터)
assert.ok((await k1.page.locator('#result-title').textContent()).includes('🏆 끝까지 살아남은 단어'), await k1.page.locator('#result-title').textContent());
await teacher.page.locator('.t-room [data-act="watch"]').click();
await until(async () => (await teacher.page.locator('.w-book strong', { hasText: '🏆' }).count()) === 3, 5000, 'teacher trophies');
assert.ok((await teacher.page.locator('.w-page span', { hasText: '💡3' }).count()) === 1, 'teacher 💡 missing');
await teacher.page.click('#t-watch-close');
console.log('all answers correct → 🏆 on every book; teacher sees 💡3');

// 4) 객관식
await nextGame('choice');
await playToGuess();
{
  const ans = await answerOf(k1);
  const opts = k1.page.locator('#guess-choice button');
  assert.equal(await k1.page.locator('#guess-choice').isVisible(), true);
  assert.equal(await opts.count(), 4);
  assert.ok((await opts.allTextContents()).includes(ans));
  assert.ok((await k1.page.locator('#hint-btn').textContent()).includes('보기 두 개 지우기'), 'hints not reset for new game');
  await k1.page.click('#hint-btn');
  await until(async () => (await k1.page.locator('#guess-choice button:disabled').count()) === 2, 5000, 'fifty');
  assert.equal(await k1.page.locator('#guess-choice button:disabled', { hasText: ans }).count(), 0, 'answer removed');
  await k1.page.screenshot({ path: `${SHOTS}/guess-choice.png`, fullPage: true });
  for (const k of kids) await k.page.locator('#guess-choice button', { hasText: await answerOf(k) }).first().click();
}
await all(async (k) => (await screen(k)) === 'screen-result', 'results (choice)');
console.log('choice mode ok');

// 5) 자유 입력 + 힌트 1개 한도
await nextGame('free', 1);
await playToGuess();
{
  const ans = await answerOf(k2);
  assert.equal(await k2.page.locator('#guess-input').isVisible(), true);
  await k2.page.click('#hint-btn');
  await until(async () => (await k2.page.locator('#hint-list li').count()) === 1, 5000, 'len hint');
  assert.equal(await k2.page.locator('#hint-list li').first().textContent(), `글자수: ${'○'.repeat([...ans].length)} (${[...ans].length}글자)`);
  assert.equal(await k2.page.locator('#hint-btn').isDisabled(), true, 'hint limit not enforced');
  assert.ok((await k2.page.locator('#hint-btn').textContent()).includes('남은 힌트 0개'));
  for (const k of kids) { await k.page.fill('#guess-input', '몰라요'); await k.page.click('#guess-submit'); }
}
await all(async (k) => (await screen(k)) === 'screen-result', 'results (free)');
assert.equal((await k2.page.locator('#result-title').textContent()).includes('🏆'), false);
console.log('free mode + hint limit ok');

await teacher.page.click('#t-close');
await until(async () => (await screen(k1)) === 'screen-home', 10000, 'class closed');

// 가짜 Gemini가 예전 모델에 일부러 준 404는 브라우저가 콘솔에 남긴다
const unexpected = errors.filter((e) => !/permission_denied|ERR_|WebSocket|status of 404/.test(e));
console.log('console errors:', unexpected.length, unexpected.slice(0, 5));
assert.equal(unexpected.length, 0);
await browser.close();
console.log('GUESS MODES E2E OK');
