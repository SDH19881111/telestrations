// 선생님 관찰·제재, 자리 되찾기, 결과 후 준비 완료 E2E (에뮬레이터 필요)
// 1) 선생님이 모둠을 들여다보면 그리는 중인 그림 미리보기가 보임
// 2) 경고 → 학생 화면에 알림  3) 그림 가리기 → 다음 사람에게 안 보이고 결과에도 '가림'
// 4) 강퇴 → 학생은 첫 화면으로, 남은 차례는 기다리지 않고 건너뜀, 같은 이름으로도 재입장 불가
// 5) 기기가 바뀐 학생(새 익명 계정)이 같은 이름으로 게임 중인 모둠에 들어오면 원래 자리에서 이어서
// 6) 결과 화면: 모두 '준비 완료'를 누르면 모둠장에게 '다음 판 시작' → 누르면 선생님 설정으로 새 게임
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:5000';
const FB = new URL('../node_modules/firebase/', import.meta.url);
const CLASS = 'MD' + Math.floor(Math.random() * 9000 + 1000);
const ROOM = `${CLASS}-1`;
const SHOTS = process.env.SHOTS || 'tests/shots';
const WORDS = ['사과', '기차', '달팽이', '연필', '우산', '로봇'];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-proxy-server'] });
const errors = [];

async function newCtx(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.route(/https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/(.*)$/, (route) => {
    route.fulfill({ contentType: 'application/javascript', body: readFileSync(new URL(route.request().url().split('/').pop(), FB)) });
  });
  return { name, ctx };
}
async function openPage(p, path) {
  const page = await p.ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${p.name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${p.name}] pageerror ${e.message}`));
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(d.defaultValue()) : d.accept()));
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
async function draw(p) {
  const box = await p.page.locator('#canvas').boundingBox();
  await p.page.mouse.move(box.x + 40, box.y + 40);
  await p.page.mouse.down();
  await p.page.mouse.move(box.x + box.width - 40, box.y + box.height / 2, { steps: 8 });
  await p.page.mouse.up();
}
const roomData = () => teacher.page.evaluate(async (id) => {
  const fb = await import('./js/firebase.js');
  return (await fb.get(fb.roomRef(id))).val();
}, ROOM);
const tile = (name) => teacher.page.locator('.w-player', { has: teacher.page.locator('.w-name span', { hasText: new RegExp(`^${name}$`) }) });

async function joinClass(k, name) {
  await openPage(k, '?emulator=1');
  await k.page.fill('#home-name', name);
  await k.page.fill('#home-code', CLASS);
  await k.page.click('#btn-join');
  await k.page.locator('#group-list button', { hasText: '1모둠' }).click();
}

// ---------- 선생님: 수업 만들고 1모둠 열기 ----------
const teacher = await openPage(await newCtx('선생님'), 'teacher.html?emulator=1');
await teacher.page.fill('#t-code', CLASS);
await teacher.page.fill('#t-pass', 'abcd1234');
await teacher.page.click('#t-login-btn');
await teacher.page.locator('#t-dash').waitFor({ state: 'visible' });
await teacher.page.selectOption('#t-groups', '1');
await teacher.page.selectOption('#t-draw', '30');
await teacher.page.selectOption('#t-guess', '15');
await teacher.page.fill('#t-words', WORDS.join('\n'));
await teacher.page.click('#t-open');
await until(async () => (await teacher.page.locator('.t-room').count()) === 1, 10000, 'room opened');

// ---------- 학생 4명 ----------
const kids = [];
for (let i = 0; i < 4; i++) {
  const k = await newCtx(`학생${i}`);
  await joinClass(k, `학생${i}`);
  await k.page.locator('#screen-lobby').waitFor({ state: 'visible' });
  kids.push(k);
}
const [k0, k1, , k3] = kids;
console.log('class', CLASS, '4 kids joined');

// ---------- 들여다보기 ----------
await teacher.page.locator('.t-room [data-act="watch"]').click();
await teacher.page.locator('#t-watch').waitFor({ state: 'visible' });
await until(async () => (await teacher.page.locator('.w-player').count()) === 4, 5000, 'watch tiles');
assert.equal((await roomData()).watch, true, 'watch flag not set');
console.log('teacher watching group 1');

await teacher.page.click('#t-watch-close');
await teacher.page.click('#t-start-all');
await teacher.page.locator('.t-room [data-act="watch"]').click();
await until(async () => (await Promise.all(kids.map(screen))).every((s) => s === 'screen-draw'), 10000, 'started');
for (const k of kids) await k.page.locator('#word-choices button').first().click();

// 1) 그리는 중 미리보기
await draw(k0);
await until(async () => (await tile('학생0').locator('.w-live img').count()) === 1, 10000, 'live preview');
const src = await tile('학생0').locator('.w-live img').getAttribute('src');
assert.ok(src.startsWith('data:image/') && src.length < 60000, 'bad preview');
console.log(`live preview of 학생0 visible (${src.length} bytes)`);

// 2) 경고
await tile('학생1').locator('[data-act="warn"]').click();
await k1.page.locator('#warn').waitFor({ state: 'visible', timeout: 5000 });
await k1.page.screenshot({ path: `${SHOTS}/mod-warning.png` });
assert.ok((await k1.page.locator('#warn-msg').textContent()).includes('선생님이 보고 있어요'));
await k1.page.click('#warn-ok');
assert.equal(await k1.page.locator('#warn').isVisible(), false);
console.log('warning shown on 학생1');

for (const k of kids) { await draw(k); await k.page.click('#draw-submit'); }
await until(async () => (await Promise.all(kids.map(screen))).every((s) => s === 'screen-guess'), 10000, 'guess round');

// 3) 가리기: 첫 스케치북의 그림을 가린다 → 그 그림을 맞히는 학생 화면에 '가렸어요'
await until(async () => (await teacher.page.locator('.w-book [data-act="hide"]').count()) >= 4, 5000, 'hide buttons');
await teacher.page.locator('.w-book').first().locator('[data-act="hide"]').first().click();
await until(async () => {
  for (const k of kids) if ((await k.page.locator('#guess-empty').isVisible()) && (await k.page.locator('#guess-empty').textContent()).includes('가렸어요')) return true;
  return false;
}, 5000, 'hidden drawing on guesser screen');
{
  const room = await roomData();
  const p = room.books[0].pages[0];
  assert.equal(p.hidden, true);
  assert.equal(p.content, '');
}
await teacher.page.screenshot({ path: `${SHOTS}/mod-watch.png`, fullPage: true });
console.log('hidden drawing is gone for the next kid');

// 4) 강퇴: 학생3 → 첫 화면, 남은 셋이 내면 바로 다음 차례
await tile('학생3').locator('[data-act="ban"]').click();
await until(async () => (await screen(k3)) === 'screen-home', 5000, 'banned kid kicked');
assert.ok((await k3.page.locator('#home-error').textContent()).includes('내보냈어요'));
await until(async () => (await tile('학생3').locator('.tag').textContent()).includes('강퇴'), 5000, 'teacher sees ban');
for (const k of kids.slice(0, 3)) { await k.page.fill('#guess-input', `답${k.name}`); await k.page.click('#guess-submit'); }
await until(async () => (await Promise.all(kids.slice(0, 3).map(screen))).every((s) => s === 'screen-draw'), 5000, 'advanced without banned kid');
console.log('banned kid removed; round advanced without waiting');

// 같은 기기(같은 계정)로도, 새 기기(같은 이름)로도 못 돌아온다
await k3.page.locator('#home-code').fill(CLASS);
await k3.page.click('#btn-join');
await k3.page.locator('#group-list button', { hasText: '1모둠' }).click();
await until(async () => (await k3.page.locator('#home-error').textContent()).includes('내보냈어요'), 5000, 'banned rejoin blocked');
const k3b = await newCtx('학생3-새기기');
await joinClass(k3b, '학생3');
await until(async () => (await k3b.page.locator('#home-error').textContent()).includes('내보냈어요'), 5000, 'banned name blocked');
assert.equal(await screen(k3b), 'screen-home');
await k3b.ctx.close();
console.log('banned kid cannot come back (same account or same name)');

// 5) 자리 되찾기: 학생2의 기기가 바뀜 (새 익명 계정) → 같은 이름으로 들어오면 그리던 차례로
const oldUid = await kids[2].page.evaluate(async () => (await import('./js/firebase.js')).auth.currentUser.uid);
await kids[2].ctx.close();
await until(async () => (await tile('학생2').locator('.tag').textContent()).includes('연결 끊김'), 10000, 'k2 offline');
const k2 = await newCtx('학생2-새기기');
await joinClass(k2, '학생2');
await until(async () => (await screen(k2)) === 'screen-draw', 12000, 'k2 reclaimed seat');
kids[2] = k2;
{
  const room = await roomData();
  const newUid = await k2.page.evaluate(async () => (await import('./js/firebase.js')).auth.currentUser.uid);
  assert.ok(room.order.includes(newUid) && !room.order.includes(oldUid), 'order not moved');
  assert.ok(!room.players[oldUid] && room.players[newUid].name === '학생2');
  assert.ok(Object.values(room.books).some((b) => Object.values(b.pages || {}).some((p) => p.by === newUid)), 'pages not moved');
  assert.ok(!room.rejoin, 'rejoin request left behind');
}
console.log('kid on a new device reclaimed their seat by name');

for (const k of kids.slice(0, 3)) { await draw(k); await k.page.click('#draw-submit'); }
await until(async () => (await Promise.all(kids.slice(0, 3).map(screen))).every((s) => s === 'screen-guess'), 5000, 'last guess round');
for (const k of kids.slice(0, 3)) { await k.page.fill('#guess-input', '마지막'); await k.page.click('#guess-submit'); }
await until(async () => (await Promise.all(kids.slice(0, 3).map(screen))).every((s) => s === 'screen-result'), 8000, 'results');

// 결과에 가린 페이지와 다른 학생 이름
{
  const txt = await teacher.page.locator('.w-book').first().textContent();
  assert.ok(txt.includes('(가림)'), txt);
}

// 6) 준비 완료 → 모둠장이 다음 판
const players = kids.slice(0, 3);
assert.equal(await k0.page.locator('#result-follow').textContent(), '📺 발표 따라가기', 'kids should start in free view');
assert.equal(await k0.page.locator('#result-start').isVisible(), true, 'leader has no start button');
assert.equal(await k1.page.locator('#result-start').isVisible(), false, 'non-leader has start button');
assert.equal(await k0.page.locator('#result-start').isDisabled(), true);
for (const k of players.slice(0, 2)) await k.page.click('#result-ready');
await until(async () => (await k0.page.locator('#result-ready-info').textContent()).startsWith('준비 2/3'), 5000, 'ready 2/3');
assert.equal(await k0.page.locator('#result-start').isDisabled(), true, 'start enabled before all ready');
console.log('ready info:', await k0.page.locator('#result-ready-info').textContent());
await players[2].page.click('#result-ready');
await until(() => k0.page.locator('#result-start').isEnabled(), 5000, 'start enabled');
await k0.page.screenshot({ path: `${SHOTS}/mod-ready.png`, fullPage: true });
assert.ok((await teacher.page.locator('#t-watch .w-player .tag').allTextContents()).filter((t) => t.includes('준비')).length === 3);
await k0.page.click('#result-start');
await until(async () => (await Promise.all(players.map(screen))).every((s) => s === 'screen-word'), 8000, 'next game started');
{
  const room = await roomData();
  assert.equal(room.order.length, 3, 'banned kid joined next game');
  assert.ok(!room.ready && !room.startRequest);
  const choices = await k1.page.locator('#word-screen-choices button').allTextContents();
  assert.ok(choices.length && choices.every((c) => WORDS.includes(c)), `choices not from teacher list: ${choices}`);
}
console.log('all ready → leader started next game with teacher words');

// 관찰 창을 닫으면 watch 해제
await teacher.page.click('#t-watch-close');
await until(async () => !(await roomData()).watch, 5000, 'watch cleared');

await teacher.page.click('#t-close');
await until(async () => (await screen(k1)) === 'screen-home', 10000, 'class closed');

const unexpected = errors.filter((e) => !/permission_denied|ERR_|WebSocket/.test(e));
console.log('console errors:', unexpected.length, unexpected.slice(0, 5));
assert.equal(unexpected.length, 0);
await browser.close();
console.log('MODERATION E2E OK');
