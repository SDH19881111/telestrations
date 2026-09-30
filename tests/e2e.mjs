// 에뮬레이터 + 여러 브라우저로 한 판 전체를 돌려 보는 E2E 테스트 (README '테스트' 참고)
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://127.0.0.1:5000/?emulator=1';
const FB = new URL('../node_modules/firebase/', import.meta.url);
const SHOTS = process.env.SHOTS || 'tests/shots';
const N = Number(process.env.N || 5);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-proxy-server'] });
const errors = [];

async function newPlayer(name, mobile = false) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 900, height: 900 } });
  await ctx.route(/https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/(.*)$/, (route) => {
    const file = route.request().url().split('/').pop();
    route.fulfill({ contentType: 'application/javascript', body: readFileSync(new URL(file, FB)) });
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror ${e.message}`));
  await page.goto(BASE);
  await page.fill('#home-name', name);
  return { name, ctx, page };
}

const visible = (p, sel) => p.page.locator(sel).isVisible();

async function currentScreen(p) {
  for (const s of ['screen-word', 'screen-draw', 'screen-guess', 'waiting', 'screen-result', 'screen-lobby']) {
    if (await visible(p, '#' + s)) return s;
  }
  return 'none';
}

async function draw(p, seed) {
  const box = await p.page.locator('#canvas').boundingBox();
  const m = p.page.mouse;
  await p.page.locator('#colors button').nth(seed % 6).click();
  await m.move(box.x + 40 + seed * 5, box.y + 40);
  await m.down();
  for (let k = 0; k < 8; k++) await m.move(box.x + 40 + k * 30, box.y + 60 + ((k * 37 + seed * 11) % 200), { steps: 3 });
  await m.up();
}

async function act(p, idx, round, { skip = false } = {}) {
  const s = await currentScreen(p);
  if (skip) return s;
  if (s === 'screen-word') {
    await p.page.fill('#word-input', `제시어${idx}`);
    await p.page.click('#word-submit');
  } else if (s === 'screen-draw') {
    if (await visible(p, '#word-pick')) {
      await p.page.locator('#word-choices button').first().click();
      await p.page.locator('#draw-area').waitFor({ state: 'visible' });
    }
    await draw(p, idx + round);
    await p.page.click('#draw-submit');
  } else if (s === 'screen-guess') {
    const src = await p.page.locator('#guess-img').getAttribute('src');
    assert.ok((src && src.startsWith('data:image/')) || (await visible(p, '#guess-empty')), `${p.name} guess image missing`);
    await p.page.fill('#guess-input', `추측${idx}-${round}`);
    await p.page.click('#guess-submit');
  }
  return s;
}

async function waitAll(players, pred, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const res = await Promise.all(players.map(pred));
    if (res.every(Boolean)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('waitAll timeout: ' + (await Promise.all(players.map(currentScreen))).join(','));
}

const hudRound = (p) => p.page.locator('#hud-round').textContent();

// ---------- 로비 ----------
const players = [];
players.push(await newPlayer('방장'));
await players[0].page.click('#btn-create');
await players[0].page.locator('#screen-lobby').waitFor({ state: 'visible' });
const code = (await players[0].page.locator('#lobby-code').textContent()).trim();
console.log('room code', code);
assert.match(code, /^[A-Z]{4}$/);
for (let i = 1; i < N; i++) {
  const p = await newPlayer(`플레이어${i}`, i === 1);
  await p.page.fill('#home-code', code.toLowerCase());
  await p.page.click('#btn-join');
  await p.page.locator('#screen-lobby').waitFor({ state: 'visible' });
  players.push(p);
  if (i === 2) await players[0].page.waitForFunction(() => document.querySelector('#btn-start').disabled); // 3명이면 시작 불가
}
await players[0].page.selectOption('#set-guess', '15');
await players[0].page.selectOption('#set-draw', '30');
await waitAll(players, async (p) => (await p.page.locator('#lobby-players li').count()) === N);
await waitAll(players, async (p) => (await p.page.locator('#set-guess').inputValue()) === '15' && (await p.page.locator('#set-draw').inputValue()) === '30');
assert.equal(await players[1].page.locator('#btn-start').isVisible(), false);
await players[0].page.screenshot({ path: `${SHOTS}/lobby-${N}.png` });

// 게임 중 신규 입장 차단 확인용 플레이어
const late = await newPlayer('지각생');

await players[0].page.click('#btn-start');
await waitAll(players, async (p) => (await currentScreen(p)) !== 'screen-lobby');

await late.page.fill('#home-code', code);
await late.page.click('#btn-join');
await late.page.waitForFunction(() => document.querySelector('#home-error').textContent.length > 0);
console.log('late join blocked:', await late.page.locator('#home-error').textContent());

// ---------- 라운드 ----------
const DROP = !!process.env.DROP;
let dropped = null;
for (let r = 0; r < N; r++) {
  if (DROP && r === 1 && !dropped) { dropped = players.pop(); await dropped.ctx.close(); console.log('  dropped', dropped.name); }
  const tR = Date.now();
  await waitAll(players, async (p) => (await hudRound(p)).startsWith(`${r + 1}/`) && (await currentScreen(p)) !== 'waiting', 50000);
  const screens = [];
  if (r === 3) {
    // 한 명 새로고침 → 같은 사람으로, 현재 라운드 화면으로 복귀
    await players[2].page.reload();
    await players[2].page.locator(N % 2 ? '#screen-draw' : '#screen-guess').waitFor({ state: 'visible', timeout: 10000 });
    console.log('  reload during round → restored to current round screen');
  }
  // r=2 에서는 마지막 플레이어가 아무것도 안 함 → 마감 자동 제출 확인
  if (await visible(players[1], '#word-pick')) { await players[1].page.locator('#word-choices button').first().click(); await players[1].page.locator('#draw-area').waitFor(); }
  if (await visible(players[1], '#draw-area')) await draw(players[1], 3);
  await players[1].page.screenshot({ path: `${SHOTS}/m-r${r}-${N}.png` });
  for (let i = 0; i < players.length; i++) screens.push(await act(players[i], i, r, { skip: !DROP && r === 2 && i === N - 1 }));
  console.log(`round ${r}:`, [...new Set(screens)].join(','), `${Date.now() - tR}ms`);
  if (r === 1) await players[1].page.screenshot({ path: `${SHOTS}/r1-mobile-${N}.png` });
  if (r === 0) await players[0].page.screenshot({ path: `${SHOTS}/r0-waiting-${N}.png` });
  if (r === 2) console.log('  waiting for timeout auto-submit...');
}

await waitAll(players, async (p) => (await currentScreen(p)) === 'screen-result', 30000);
console.log('all on result screen');

// ---------- 결과 발표 모드 ----------
const host = players[0];
const pagesPerBook = N % 2 === 0 ? N + 1 : N;
for (let k = 0; k < pagesPerBook; k++) await host.page.click('#result-next');
await waitAll(players, async (p) => (await p.page.locator('#result-title').textContent()).includes(`(2/${N})`));
console.log('presentation sync ok:', await players[3].page.locator('#result-title').textContent());
// 첫 스케치북 내용 확인 (방장 화면에서 이전으로)
await host.page.click('#result-prev');
await waitAll(players, async (p) => (await p.page.locator('#result-pages .entry').count()) === pagesPerBook);
const texts = await players[3].page.locator('#result-pages .entry').allTextContents();
console.log('book1:', texts.map((t) => t.replace(/\s+/g, ' ').slice(0, 40)));
const skippedCount = texts.filter((t) => t.includes('(건너뜀)') || t.includes('(빈 답)')).length;
await players[1].page.screenshot({ path: `${SHOTS}/result-mobile-${N}.png`, fullPage: true });
await host.page.screenshot({ path: `${SHOTS}/result-host-${N}.png`, fullPage: true });

// 자유 보기
await players[2].page.click('#result-follow');
await players[2].page.click('#result-next');
await host.page.click('#result-next');

// ---------- 준비 완료 → 방장에게 '다음 판 시작' ----------
{
  const active = [];
  for (const p of players) if (!p.page.isClosed() && (await p.page.locator('#result-ready').isVisible())) active.push(p);
  assert.equal(await host.page.locator('#result-start').isVisible(), true, 'host has no start button');
  assert.equal(await active.find((p) => p !== host).page.locator('#result-start').isVisible(), false, 'guest has start button');
  for (const p of active) await p.page.click('#result-ready');
  await waitAll([host], async (p) => (await p.page.locator('#result-ready-info').textContent()).startsWith(`준비 ${active.length}/${active.length}`));
  if (active.length >= 4) await waitAll([host], (p) => p.page.locator('#result-start').isEnabled());
  await active.find((p) => p !== host).page.click('#result-ready'); // 취소하면 다시 막힘
  await waitAll([host], (p) => p.page.locator('#result-start').isDisabled());
  console.log('ready → host start button ok:', await host.page.locator('#result-ready-info').textContent());
}

// ---------- 방장 이탈 → 위임 ----------
await host.ctx.close();
const t0 = Date.now();
let newHost = null;
while (!newHost && Date.now() - t0 < 15000) {
  for (const p of players.slice(1)) if (await p.page.locator('#result-lobby').isVisible()) newHost = p;
  await new Promise((r) => setTimeout(r, 300));
}
assert.ok(newHost, 'host migration failed');
console.log('new host:', newHost.name);
await newHost.page.click('#result-lobby');
await waitAll(players.slice(1), async (p) => (await currentScreen(p)) === 'screen-lobby');
console.log('back to lobby ok; host label:', await players[1].page.locator('#lobby-players li').first().textContent());

const bad = errors.filter((e) => /PERMISSION|denied|pageerror|Error/i.test(e));
console.log('console warnings/errors:', errors.length, '\n' + errors.slice(0, 15).join('\n'));
await browser.close();
if (bad.length) { console.error('FAIL: errors found'); process.exit(1); }
console.log(`E2E OK (N=${N}, auto-submitted/skipped entries in book1: ${skippedCount})`);
