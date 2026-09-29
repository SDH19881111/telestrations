// 수업 중 튕김·멈춤 E2E (에뮬레이터 필요)
// 1) 게임 중 탭을 닫았다가 수업 링크로 다시 들어오면 자기 모둠에 복귀
// 2) 그리던 그림이 되살아남, 제출하면 임시 저장 삭제
// 3) 방에 있는 동안 화면 꺼짐 방지(Wake Lock) 요청
// 4) 게임 중 선생님 화면을 닫으려 하면 경고, 닫히면 학생 화면에 멈춤 안내 → 다시 열면 이어서 진행
// 5) 잠깐 끊긴 학생은 바로 건너뛰지 않고 기다림  6) 제시어를 못 고르고 빠지면 후보 첫 번째로 채움
// 7) 선생님 화면에 아직 안 낸 학생 이름  8) 같은 모둠에 같은 이름 입장 불가
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:5000';
const FB = new URL('../node_modules/firebase/', import.meta.url);
const CLASS = 'RC' + Math.floor(Math.random() * 9000 + 1000);
const WORDS = ['사과', '기차', '달팽이', '연필'];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-proxy-server'] });
const errors = [];
const dialogs = [];

// 가짜 Wake Lock: 요청·해제 횟수를 센다 (헤드리스 브라우저는 실제 잠금이 안 됨)
const FAKE_WAKELOCK = `
  window.__wl = 0; window.__wlReleased = 0;
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => {
    window.__wl++;
    const t = new EventTarget();
    t.release = async () => { window.__wlReleased++; t.dispatchEvent(new Event('release')); };
    return t;
  } } });`;

async function newCtx(name, mobile = false) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1200, height: 900 } });
  await ctx.route(/https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/(.*)$/, (route) => {
    route.fulfill({ contentType: 'application/javascript', body: readFileSync(new URL(route.request().url().split('/').pop(), FB)) });
  });
  await ctx.addInitScript(FAKE_WAKELOCK);
  return { name, ctx };
}
async function openPage(p, path) {
  const page = await p.ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${p.name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${p.name}] pageerror ${e.message}`));
  page.on('dialog', (d) => { dialogs.push(`${p.name}:${d.type()}`); d.accept(); });
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
async function draw(p, dy = 0) {
  const box = await p.page.locator('#canvas').boundingBox();
  await p.page.mouse.move(box.x + 40, box.y + 40 + dy);
  await p.page.mouse.down();
  await p.page.mouse.move(box.x + box.width - 40, box.y + box.height / 2 + dy, { steps: 8 });
  await p.page.mouse.up();
}
const inkPixels = (p) => p.page.evaluate(() => {
  const c = document.querySelector('#canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 16) if (d[i] < 200) n++;
  return n;
});
const drafts = (p) => p.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('tele.draft.')).length);

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
assert.ok(await teacher.page.evaluate(() => window.__wl) >= 1, 'teacher wake lock not requested');
console.log('class', CLASS, 'opened; teacher wake lock requested');

// ---------- 학생 3명 입장 ----------
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
for (const k of kids) assert.ok(await k.page.evaluate(() => window.__wl) >= 1, `${k.name} wake lock not requested`);
console.log('3 kids joined; kid wake locks requested');
const [k0, k1, k2] = kids;

// 같은 이름으로는 못 들어온다
const dup = await openPage(await newCtx('같은이름'), '?emulator=1');
await dup.page.fill('#home-name', '학생1');
await dup.page.fill('#home-code', CLASS);
await dup.page.click('#btn-join');
await dup.page.locator('#group-list button', { hasText: '1모둠' }).click();
await until(async () => (await dup.page.locator('#home-error').textContent()).length > 0, 10000, 'dup name error');
const dupMsg = await dup.page.locator('#home-error').textContent();
assert.ok(dupMsg.includes('이미 있어요'), dupMsg);
assert.equal(await screen(dup), 'screen-home');
console.log('duplicate name blocked:', dupMsg);
await dup.ctx.close();

await teacher.page.click('#t-start-all');
await until(async () => (await Promise.all(kids.map(screen))).every((s) => s === 'screen-word'), 10000, 'started (word round)');
for (const k of [k0, k1]) await k.page.locator('#word-screen-choices button').first().click();

// 학생2가 제시어를 고르기 전에 잠깐 끊김 → 선생님 화면에 표시, 게임은 바로 넘어가지 않고 기다린다
const hint = () => teacher.page.locator('.t-room .t-room-hint').textContent();
await until(async () => (await hint()).includes('학생2') && !(await hint()).includes('학생0'), 10000, 'teacher sees pending kid');
console.log('teacher sees:', await hint());
await k2.page.close();
await until(async () => (await hint()).includes('학생2(연결 끊김)'), 10000, 'teacher sees disconnected kid');
console.log('teacher sees:', await hint());
await sleep(3000);
assert.equal(await screen(k0), 'waiting', 'round advanced right after a brief disconnect');
await openPage(k2, `?emulator=1&class=${encodeURIComponent(CLASS)}`);
await k2.page.locator('#group-list button', { hasText: '1모둠' }).click();
await until(async () => (await screen(k2)) === 'screen-word', 10000, 'k2 back on word screen');
await k2.page.locator('#word-screen-choices button').first().click();
console.log('briefly disconnected kid was waited for and rejoined');

// ---------- 그리기 라운드: 학생0이 그리다가 튕김 ----------
await until(async () => (await Promise.all(kids.map(screen))).every((s) => s === 'screen-draw'), 15000, 'draw round');
{
  const h = await hint();
  assert.ok(h.startsWith('아직 안 낸 학생') && ['학생0', '학생1', '학생2'].every((n) => h.includes(n)), h);
}
await draw(k0);
const before = await inkPixels(k0);
assert.ok(before > 0);
assert.equal(await drafts(k0), 1, 'draft not saved');
await draw(k1);
await k0.page.close(); // 탭이 닫힘 (튕김)

// 다른 학생(모둠에 없는 사람)에게는 '게임 중'으로 잠겨 있어야 한다
const late = await openPage(await newCtx('늦은학생'), `?emulator=1&class=${encodeURIComponent(CLASS)}`);
await late.page.fill('#home-name', '늦은학생');
await sleep(1500); // 로그인이 끝날 때 이름이 있으면 바로 모둠 고르기가 뜬다
if (await late.page.locator('#home-main').isVisible()) await late.page.click('#btn-join');
const lateBtn = late.page.locator('#group-list button', { hasText: '1모둠' });
await lateBtn.waitFor({ state: 'visible' });
assert.equal(await lateBtn.isDisabled(), true, 'non-member can join a playing group');
console.log('non-member sees:', (await lateBtn.textContent()).trim());
await late.ctx.close();

// 학생0: 선생님이 준 수업 링크로 다시 들어온다 (이름은 기억됨 → 바로 모둠 고르기)
await openPage(k0, `?emulator=1&class=${encodeURIComponent(CLASS)}`);
const myBtn = k0.page.locator('#group-list button', { hasText: '1모둠' });
await myBtn.waitFor({ state: 'visible' });
assert.equal(await myBtn.isDisabled(), false, 'own group locked during game');
console.log('rejoining kid sees:', (await myBtn.textContent()).trim());
await myBtn.click();
await until(async () => (await screen(k0)) === 'screen-draw', 10000, 'back to draw screen');
assert.equal(await k0.page.locator('#toast').textContent(), '그리던 그림을 되살렸어요.');
const after = await inkPixels(k0);
// 그릴 때는 선분마다, 되살릴 때는 한 번에 그려서 가장자리 픽셀이 조금 다를 수 있다
assert.ok(Math.abs(after - before) <= before * 0.05, `drawing not restored (${before} → ${after})`);
console.log(`drawing restored after rejoin (${after} ink samples)`);

await draw(k0, 60);
await k0.page.click('#draw-submit');
await until(async () => (await screen(k0)) === 'waiting', 5000, 'k0 submitted');
assert.equal(await drafts(k0), 0, 'draft not cleared after submit');
await k1.page.click('#draw-submit');
await draw(k2);
await k2.page.click('#draw-submit');
console.log('drafts cleared after submit');

// ---------- 추측 라운드: 선생님 화면이 닫힘 ----------
await until(async () => (await Promise.all(kids.map(screen))).every((s) => s === 'screen-guess'), 15000, 'guess round');
assert.equal(await k1.page.locator('#stall').isVisible(), false);
await teacher.page.close({ runBeforeUnload: true });
await until(() => dialogs.includes('선생님:beforeunload'), 5000, 'beforeunload warning');
await until(() => teacher.page.isClosed(), 5000, 'teacher closed');
console.log('teacher got leave warning during game');

// 학생은 추측을 제출하지 않고 기다린다 → 마감(15초) + 6초가 지나면 멈춤 안내
await until(() => k1.page.locator('#stall').isVisible(), 30000, 'stall notice');
const stallText = await k1.page.locator('#stall').textContent();
assert.ok(stallText.includes('선생님 화면'), stallText);
console.log('kid sees:', stallText);

// 선생님이 다시 열면 이어서 진행 → 결과
await openPage(teacher, 'teacher.html?emulator=1');
await teacher.page.locator('#t-dash').waitFor({ state: 'visible', timeout: 10000 });
await until(async () => (await Promise.all(kids.map(screen))).every((s) => s === 'screen-result'), 15000, 'results after teacher returns');
assert.equal(await k1.page.locator('#stall').isVisible(), false, 'stall notice stays');
console.log('teacher reopened → game finished, stall notice gone');

// 결과에 학생0의 그림이 남아 있다
const entries = await k1.page.evaluate(() => document.querySelectorAll('#result-pages .entry').length);
assert.ok(entries >= 1);

// ---------- 두 번째 판: 학생2가 제시어를 못 고르고 빠짐 → 후보 첫 번째로 채워짐 ----------
await teacher.page.locator('.t-room [data-act="lobby"]').click();
await until(async () => (await screen(k1)) === 'screen-lobby' && (await screen(k2)) === 'screen-lobby', 10000, 'back to lobby');
await teacher.page.click('#t-start-all');
await until(async () => (await Promise.all(kids.map(screen))).every((s) => s === 'screen-word'), 10000, 'game 2 word round');
for (const k of [k0, k1]) await k.page.locator('#word-screen-choices button').first().click();
const k2uid = await k2.page.evaluate(async () => (await import('./js/firebase.js')).auth.currentUser.uid);
await k2.page.close();
await until(async () => (await screen(k0)) === 'screen-draw', 25000, 'advanced after k2 left');
const room = await teacher.page.evaluate(async (id) => {
  const fb = await import('./js/firebase.js');
  return (await fb.get(fb.roomRef(id))).val();
}, `${CLASS}-1`);
const k2book = Object.values(room.books).find((b) => b.owner === k2uid);
assert.equal(k2book.pages[0].content, k2book.choices[0], `missing first word: ${JSON.stringify(k2book.pages[0])}`);
assert.ok(!k2book.pages[0].skipped);
console.log("left kid's first word auto-filled:", k2book.pages[0].content);

// 정리: 수업 끝내기 (게임 중이라 확인창 → 수락)
await teacher.page.click('#t-close');
await until(async () => (await screen(k1)) === 'screen-home', 10000, 'class closed');

const unexpected = errors.filter((e) => !/permission_denied|ERR_|WebSocket/.test(e));
console.log('console errors:', unexpected.length, unexpected.slice(0, 5));
assert.equal(unexpected.length, 0);
await browser.close();
console.log('RECONNECT E2E OK');
