// 수업(선생님) 모드 E2E: 선생님 로그인 → 설정 → 모둠 방 열기 → 학생 입장 → 전체 시작 → 결과 발표 → 강퇴 → 수업 끝내기
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:5000';
const FB = new URL('../node_modules/firebase/', import.meta.url);
const SHOTS = process.env.SHOTS || 'tests/shots';
const CLASS = '3반' + Math.floor(Math.random() * 900 + 100); // 테스트마다 새 수업 코드
const TEACHER_WORDS = ['광합성', '화산', '자석', '무지개', '달의 모양'];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-proxy-server'] });
const errors = [];

async function open(name, path, opts = {}) {
  const ctx = await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1200, height: 900 } });
  await ctx.route(/https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/(.*)$/, (route) => {
    route.fulfill({ contentType: 'application/javascript', body: readFileSync(new URL(route.request().url().split('/').pop(), FB)) });
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${ORIGIN}/${path}`);
  return { name, ctx, page };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 20000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return; await sleep(200); }
  throw new Error('timeout: ' + label);
}
const visible = (p, sel) => p.page.locator(sel).isVisible();
async function screen(p) {
  for (const s of ['screen-word', 'screen-draw', 'screen-guess', 'waiting', 'screen-result', 'screen-lobby', 'screen-home']) {
    if (await visible(p, '#' + s)) return s;
  }
  return 'none';
}

// ---------- 선생님 로그인·설정 ----------
const teacher = await open('선생님', 'teacher.html?emulator=1');
await teacher.page.fill('#t-code', CLASS);
await teacher.page.fill('#t-pass', 'abcd1234');
await teacher.page.click('#t-login-btn');
await teacher.page.locator('#t-dash').waitFor({ state: 'visible' });
console.log('class created:', CLASS);

await teacher.page.selectOption('#t-groups', '2');
await teacher.page.selectOption('#t-draw', '30');
await teacher.page.selectOption('#t-guess', '15');
// '지금 저장'을 누르지 않고 바로 방을 연다 (실제 선생님 사용 흐름)
await teacher.page.fill('#t-words', TEACHER_WORDS.join('\n'));
await teacher.page.click('#t-open');
await until(async () => (await teacher.page.locator('.t-room').count()) === 2, 10000, 'rooms opened');
console.log('2 group rooms opened');

// 비밀번호가 틀리면 로그인 불가
const intruder = await open('침입자', 'teacher.html?emulator=1');
await intruder.page.fill('#t-code', CLASS);
await intruder.page.fill('#t-pass', 'wrongpass');
await intruder.page.click('#t-login-btn');
await until(async () => (await intruder.page.locator('#t-login-error').textContent()).length > 0 || (await intruder.page.locator('#t-dash').isVisible()), 10000, 'wrong pw');
assert.equal(await intruder.page.locator('#t-dash').isVisible(), false, 'wrong password got in');
assert.equal(await intruder.page.locator('#t-login-error').textContent(), '비밀번호가 맞지 않아요.');
console.log('wrong password rejected');
await intruder.ctx.close();

// ---------- 학생 입장 ----------
const kids = [];
const plan = [1, 1, 1, 1, 2, 2, 2]; // 1모둠 4명(짝수), 2모둠 3명(홀수)
for (let i = 0; i < plan.length; i++) {
  const k = await open(`학생${i}`, '?emulator=1', { mobile: i === 0 });
  await k.page.fill('#home-name', `학생${i}`);
  await k.page.fill('#home-code', CLASS);
  await k.page.click('#btn-join');
  await k.page.locator('#group-pick').waitFor({ state: 'visible' });
  if (i === 0) await k.page.screenshot({ path: `${SHOTS}/class-group-pick.png` });
  await k.page.locator('#group-list button', { hasText: `${plan[i]}모둠` }).click();
  await k.page.locator('#screen-lobby').waitFor({ state: 'visible' });
  k.group = plan[i];
  kids.push(k);
}
assert.equal(await kids[0].page.locator('#lobby-code').textContent(), '1모둠');
assert.equal(await kids[1].page.locator('#btn-start').isVisible(), false); // 모둠장(kids[0])이 아니면 시작 버튼 없음
await until(() => kids[0].page.locator('#btn-start').isVisible(), 10000, 'group 1 leader button');
assert.equal(await kids[0].page.locator('#lobby-settings').isVisible(), false);
console.log('kids joined; lobby hint:', await kids[0].page.locator('#lobby-hint').textContent());

// 학생은 진행권(hostId)을 가져갈 수 없다 (보안 규칙)
const denied = await kids[1].page.evaluate(async (id) => {
  const fb = await import('./js/firebase.js');
  try { await fb.set(fb.roomRef(id, 'hostId'), fb.auth.currentUser.uid); return false; } catch { return true; }
}, `${CLASS}-1`);
assert.ok(denied, 'student could take host');
console.log('student host takeover denied');

// 선생님 브라우저에서 학생 화면을 열면 같은 사용자로 인식된다 → 그래도 학생 화면에 시작 버튼이 나오면 안 된다
// (나오면 학생 화면이 기본 제시어로 게임을 시작해 버림)
const sameBrowser = await teacher.ctx.newPage();
sameBrowser.on('dialog', (d) => d.accept());
await sameBrowser.goto(`${ORIGIN}/?emulator=1`);
await sameBrowser.fill('#home-name', '선생님탭');
await sameBrowser.fill('#home-code', CLASS);
await sameBrowser.click('#btn-join');
await sameBrowser.locator('#group-list button', { hasText: '2모둠' }).click();
await sameBrowser.locator('#screen-lobby').waitFor({ state: 'visible' });
assert.equal(await sameBrowser.locator('#btn-start').isVisible(), false, 'student tab in teacher browser shows start button');
await sameBrowser.click('#btn-leave');
await sameBrowser.locator('#screen-home').waitFor({ state: 'visible' }); // 나가기가 끝나면 첫 화면
await sameBrowser.close();
console.log('student tab in teacher browser cannot start the game');

await until(async () => (await teacher.page.locator('.t-room .players li').count()) === 7, 10000, 'teacher sees kids');
await teacher.page.screenshot({ path: `${SHOTS}/class-teacher-lobby.png`, fullPage: true });

// ---------- 모둠장 시작 (2모둠) ----------
const leader2 = kids[4]; // 2모둠에 가장 먼저 들어온 학생
await until(() => leader2.page.locator('#btn-start').isVisible(), 10000, 'leader start button');
assert.equal(await kids[5].page.locator('#btn-start').isVisible(), false, 'non-leader sees start');
console.log('leader hint for others:', await kids[5].page.locator('#lobby-hint').textContent());
// 선생님이 끄면 모둠장 버튼이 사라진다
await teacher.page.uncheck('#t-leader');
await until(async () => !(await leader2.page.locator('#btn-start').isVisible()), 10000, 'toggle off hides button');
await teacher.page.check('#t-leader');
await until(() => leader2.page.locator('#btn-start').isVisible(), 10000, 'toggle on shows button');
await leader2.page.click('#btn-start');
await until(async () => (await screen(leader2)) !== 'screen-lobby', 10000, 'leader started group 2');
assert.equal(await screen(kids[0]), 'screen-lobby', 'group 1 should still wait');
console.log('group 2 started by its leader; group 1 still waiting');

// ---------- 나머지는 선생님이 전체 시작 → 게임 진행 ----------
await teacher.page.click('#t-start-all');
await until(async () => (await Promise.all(kids.map(screen))).every((s) => s !== 'screen-lobby'), 10000, 'started');

const roundsOf = (g) => (g === 1 ? 4 : 3);
for (let r = 0; r < 4; r++) {
  for (const [i, k] of kids.entries()) {
    if (r >= roundsOf(k.group)) continue;
    await until(async () => (await k.page.locator('#hud-round').textContent()).startsWith(`${r + 1}/`) && (await screen(k)) !== 'waiting', 40000, `r${r} ${k.name}`);
    const s = await screen(k);
    if (s === 'screen-word') {
      // 수업 방은 홀수 인원이어도 선생님 목록에서 고른다
      assert.equal(await visible(k, '#word-free'), false, 'free typing shown in class room');
      const choices = await k.page.locator('#word-screen-choices button').allTextContents();
      assert.ok(choices.length > 0 && choices.every((c) => TEACHER_WORDS.includes(c)), `word choices not from teacher list: ${choices}`);
      await k.page.locator('#word-screen-choices button').first().click();
    } else if (s === 'screen-draw') {
      if (await visible(k, '#word-pick')) {
        const choices = await k.page.locator('#word-choices button').allTextContents();
        assert.ok(choices.length > 0 && choices.every((c) => TEACHER_WORDS.includes(c)), `choices not from teacher list: ${choices}`);
        assert.equal(await visible(k, '#word-custom-row'), false, 'custom word input shown in class room');
        await k.page.locator('#word-choices button').first().click();
      }
      const box = await k.page.locator('#canvas').boundingBox();
      await k.page.mouse.move(box.x + 30, box.y + 30);
      await k.page.mouse.down();
      await k.page.mouse.move(box.x + 200, box.y + 150 + i * 10, { steps: 5 });
      await k.page.mouse.up();
      await k.page.click('#draw-submit');
    } else if (s === 'screen-guess') {
      await k.page.fill('#guess-input', `추측${i}`);
      await k.page.click('#guess-submit');
    }
  }
  if (r === 1) await teacher.page.screenshot({ path: `${SHOTS}/class-teacher-playing.png`, fullPage: true });
  console.log(`round ${r} done`);
}
await until(async () => (await Promise.all(kids.map(screen))).every((s) => s === 'screen-result'), 20000, 'results');
console.log('all groups finished');
for (const k of [kids[0], kids[4]]) {
  const first = (await k.page.locator('#result-pages .entry').first().textContent()).replace(/^.*·\s*제시어/, '').trim();
  assert.ok(TEACHER_WORDS.includes(first), `first word not from teacher list: ${first}`);
}
console.log('results start with teacher words');

// ---------- 결과 발표 (1모둠) ----------
await until(async () => (await teacher.page.locator('.t-room').first().locator('[data-act="present"]').isVisible()), 10000, 'present btn');
await teacher.page.locator('.t-room').first().locator('[data-act="present"]').click();
await teacher.page.locator('#t-present').waitFor({ state: 'visible' });
// 학생 화면은 혼자 넘겨 보기로 시작한다 → '발표 따라가기'를 누르면 선생님 화면을 따라간다
assert.equal(await kids[1].page.locator('#result-follow').textContent(), '📺 발표 따라가기');
await kids[1].page.click('#result-follow');
for (let s = 0; s < 3; s++) await teacher.page.click('#result-next');
await until(async () => (await kids[1].page.locator('#result-pages .entry').count()) === 4, 10000, 'kids follow teacher');
await teacher.page.screenshot({ path: `${SHOTS}/class-present.png` });
console.log('presentation synced to group 1 kids');

// 대기실로 → 강퇴
await teacher.page.click('#result-lobby');
await until(async () => (await screen(kids[3])) === 'screen-lobby', 10000, 'back to lobby');
await teacher.page.locator('.t-room').first().locator('button.kick').last().click();
await until(async () => (await screen(kids[3])) === 'screen-home', 10000, 'kicked');
console.log('kicked kid sees:', await kids[3].page.locator('#home-error').textContent());

// 선생님 새로고침 → 자동 로그인
await teacher.page.reload();
await teacher.page.locator('#t-dash').waitFor({ state: 'visible', timeout: 10000 });
console.log('teacher reload → dashboard restored');

// 수업 끝내기
await teacher.page.click('#t-close');
await until(async () => (await screen(kids[0])) === 'screen-home', 10000, 'closed');
console.log('class closed; kid sees:', await kids[0].page.locator('#home-error').textContent());
// 닫힌 수업에는 입장 불가
await kids[0].page.fill('#home-code', CLASS);
await kids[0].page.click('#btn-join');
await until(async () => (await kids[0].page.locator('#home-error').textContent()).includes('열리지'), 10000, 'closed join');

// 테스트가 일부러 일으킨 거부(틀린 비밀번호, 학생의 진행권 탈취 시도)만 허용
const bad = errors.filter((e) => !(e.includes('permission_denied') && (e.startsWith('[침입자]') || e.includes('/hostId'))));
console.log('console warnings/errors:', errors.length, '\n' + errors.slice(0, 15).join('\n'));
await browser.close();
if (bad.length) { console.error('FAIL: errors found'); process.exit(1); }
console.log('CLASSROOM E2E OK');
