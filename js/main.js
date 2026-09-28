// 화면 전환, 방 상태 구독
import { ensureAuth, isConfigured, onValue, get, roomRef, serverNow } from './firebase.js';
import {
  createRoom, joinRoom, leaveRoom, startPresence, stopPresence, updateSettings, maybeClaimHost,
  normalizeCode, cleanName, RoomError, MIN_PLAYERS, MAX_PLAYERS,
} from './room.js';
import {
  pageType, bookFor, startGame, hostTick, submitPage, chooseWord, backToLobby, onlinePlayers,
} from './game.js';
import { Sketch, COLORS, SIZES } from './canvas.js';
import { renderResult, resetResult } from './result.js';

const $ = (sel) => document.querySelector(sel);
const SCREENS = ['screen-home', 'screen-lobby', 'screen-word', 'screen-draw', 'screen-guess', 'screen-result', 'waiting'];
const FALLBACK_WORDS = ['고양이', '비행기', '눈사람', '피자', '로봇', '무지개', '해적', '공룡', '우산', '기린', '자전거', '화산'];

const state = {
  uid: null,
  code: null,
  room: null,
  unsub: null,
  screenKey: '',
  sentRound: null, // 내가 제출 요청을 보낸 라운드 (DB 반영 전 중복 제출 방지)
  words: FALLBACK_WORDS,
};

let sketch = null;

// ---------- 공통 ----------
function show(id) {
  for (const s of SCREENS) $('#' + s).hidden = s !== id;
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function setUrlRoom(code) {
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code); else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

function inviteLink(code) {
  const url = new URL(location.href);
  url.search = '';
  if (new URLSearchParams(location.search).has('emulator')) url.searchParams.set('emulator', '1');
  url.searchParams.set('room', code);
  return url.toString();
}

function myName() {
  return cleanName($('#home-name').value);
}

function me() {
  const { room, uid } = state;
  if (!room || !room.order) return null;
  const i = room.order.indexOf(uid);
  if (i < 0) return null;
  const N = room.order.length;
  const r = room.round;
  return { i, N, r, b: bookFor(i, r, N), type: pageType(r, N) };
}

function hasSubmitted() {
  const { room, uid } = state;
  return !!(room.submitted && room.submitted[room.round] && room.submitted[room.round][uid]) ||
    state.sentRound === room.round;
}

// ---------- 방 입장/퇴장 ----------
function enterRoom(code) {
  state.code = code;
  state.screenKey = '';
  state.sentRound = null;
  resetResult();
  setUrlRoom(code);
  localStorage.setItem('tele.name', myName());
  startPresence(code, state.uid);
  state.unsub = onValue(roomRef(code), (snap) => onRoom(snap.val()), (err) => {
    console.error(err);
    exitRoom('방 정보를 불러오지 못했어요.');
  });
}

function exitRoom(message = '') {
  if (state.unsub) state.unsub();
  stopPresence();
  Object.assign(state, { code: null, room: null, unsub: null, screenKey: '', sentRound: null });
  setUrlRoom(null);
  $('#hud').hidden = true;
  show('screen-home');
  $('#home-error').textContent = message;
}

function onRoom(room) {
  if (!room || !room.players) return exitRoom('방이 사라졌어요.');
  if (!room.players[state.uid]) return exitRoom('방에서 나왔어요.');
  state.room = room;
  if (room.phase !== 'playing') state.sentRound = null;
  maybeClaimHost(state.code, room, state.uid);
  render();
  if (room.hostId === state.uid) hostTick(state.code, room);
}

// ---------- 렌더링 ----------
function render() {
  const { room } = state;
  const m = me();
  let key;
  if (room.phase === 'lobby' || (room.phase === 'playing' && !m)) key = 'lobby';
  else if (room.phase === 'result') key = 'result';
  else if (hasSubmitted()) key = `wait:${room.round}`;
  else key = `play:${room.order.join()}:${room.round}`;

  const changed = key !== state.screenKey;
  state.screenKey = key;
  $('#hud').hidden = !(room.phase === 'playing' && m);

  if (key === 'lobby') { show('screen-lobby'); renderLobby(); return; }
  if (key === 'result') {
    if (changed) resetResult();
    show('screen-result');
    renderResult({ room, uid: state.uid, code: state.code });
    return;
  }
  if (key.startsWith('wait')) { show('waiting'); updateHud(); return; }

  if (m.type === 'word') {
    if (changed) { $('#word-input').value = ''; show('screen-word'); $('#word-input').focus(); }
  } else if (m.type === 'draw') {
    if (changed) { sketch.reset(); $('#word-custom').value = ''; show('screen-draw'); }
    renderDraw(m);
  } else {
    if (changed) { $('#guess-input').value = ''; show('screen-guess'); renderGuess(m); $('#guess-input').focus(); }
  }
  updateHud();
}

function renderLobby() {
  const { room, uid, code } = state;
  const isHost = room.hostId === uid;
  $('#lobby-code').textContent = code;
  const entries = Object.entries(room.players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  const online = onlinePlayers(room).length;
  $('#lobby-count').textContent = `${entries.length}/${MAX_PLAYERS}`;

  const ul = $('#lobby-players');
  ul.innerHTML = '';
  for (const [id, p] of entries) {
    const li = document.createElement('li');
    li.className = p.online ? '' : 'offline';
    li.textContent = p.name;
    if (id === room.hostId) li.prepend('👑 ');
    if (id === uid) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '나';
      li.appendChild(tag);
    }
    if (!p.online) {
      const tag = document.createElement('span');
      tag.className = 'tag muted';
      tag.textContent = '오프라인';
      li.appendChild(tag);
    }
    ul.appendChild(li);
  }

  const settings = room.settings || {};
  $('#set-draw').value = String(settings.drawSec);
  $('#set-guess').value = String(settings.guessSec);
  $('#set-draw').disabled = !isHost;
  $('#set-guess').disabled = !isHost;

  const playing = room.phase === 'playing';
  $('#lobby-banner').hidden = !playing;
  $('#lobby-banner').textContent = playing ? '게임이 진행 중이에요. 이번 판이 끝나면 함께할 수 있어요.' : '';
  $('#btn-start').hidden = !isHost || playing;
  $('#btn-start').disabled = online < MIN_PLAYERS;
  $('#lobby-hint').textContent = playing
    ? ''
    : isHost
      ? (online < MIN_PLAYERS ? `${MIN_PLAYERS}명 이상 모이면 시작할 수 있어요 (지금 ${online}명)` : `${online}명이 함께해요. 시작해 볼까요?`)
      : '방장이 게임을 시작하기를 기다리는 중…';
}

function prevPage(m) {
  const book = (state.room.books && state.room.books[m.b]) || {};
  return book.pages && book.pages[m.r - 1];
}

function renderDraw(m) {
  const book = (state.room.books && state.room.books[m.b]) || {};
  let prompt;
  let picking = false;
  if (m.r === 0) {
    // 짝수 인원 1라운드: 자기 제시어를 고르거나 직접 써서 그린다
    picking = !book.word;
    prompt = book.word || '';
    if (picking) {
      const box = $('#word-choices');
      const choices = book.choices || [];
      if (box.dataset.key !== choices.join()) {
        box.dataset.key = choices.join();
        box.innerHTML = '';
        for (const w of choices) {
          const btn = document.createElement('button');
          btn.className = 'btn choice';
          btn.textContent = w;
          btn.addEventListener('click', () => pickWord(w));
          box.appendChild(btn);
        }
      }
    }
  } else {
    const prev = prevPage(m);
    prompt = prev && prev.content ? prev.content : '(앞사람이 비워 뒀어요. 자유롭게 그려 주세요!)';
  }
  $('#word-pick').hidden = !picking;
  $('#draw-area').hidden = picking;
  $('#draw-prompt').textContent = prompt;
}

function renderGuess(m) {
  const prev = prevPage(m);
  const has = !!(prev && prev.content);
  $('#guess-img').hidden = !has;
  $('#guess-empty').hidden = has;
  if (has) $('#guess-img').src = prev.content;
}

function updateHud() {
  const { room } = state;
  if (!room || room.phase !== 'playing' || !room.order) return;
  const N = room.order.length;
  const done = Object.keys((room.submitted && room.submitted[room.round]) || {}).length;
  const remain = Math.max(0, Math.ceil((room.deadline - serverNow()) / 1000));
  const label = { word: '제시어', draw: '그리기', guess: '추측' }[pageType(room.round, N)];
  $('#hud-round').textContent = `${room.round + 1}/${N} ${label}`;
  $('#hud-count').textContent = `제출 ${done}/${N}`;
  $('#hud-timer').textContent = `⏱ ${remain}`;
  $('#hud-timer').classList.toggle('urgent', remain <= 10);
  $('#waiting-count').textContent = `${done} / ${N} 제출`;
}

// ---------- 제출 ----------
async function submitCurrent(auto = false) {
  const m = me();
  const { room } = state;
  if (!m || room.phase !== 'playing' || hasSubmitted()) return;
  let content;
  if (m.type === 'draw') content = sketch.isEmpty() ? '' : sketch.toDataURL();
  else if (m.type === 'word') content = $('#word-input').value.trim().slice(0, 20);
  else content = $('#guess-input').value.trim().slice(0, 30);

  if (!auto && !content) {
    toast(m.type === 'draw' ? '그림을 조금이라도 그려 주세요!' : '답을 적어 주세요!');
    return;
  }
  const round = room.round;
  state.sentRound = round;
  render();
  try {
    await submitPage(state.code, room, state.uid, content);
    if (auto) toast('시간이 다 돼서 자동으로 제출했어요.');
  } catch (e) {
    console.error(e);
    if (state.sentRound === round) state.sentRound = null;
    if (state.room && state.room.round === round) { toast('제출하지 못했어요. 다시 눌러 주세요.'); render(); }
  }
}

async function pickWord(word) {
  const w = word.trim().slice(0, 20);
  if (!w) return toast('제시어를 적어 주세요!');
  try {
    await chooseWord(state.code, state.room, state.uid, w);
  } catch (e) {
    console.error(e);
    toast('제시어를 저장하지 못했어요.');
  }
}

// 250ms마다: 타이머 표시, 마감 시 자동 제출, 방장 진행 체크
function tick() {
  const { room } = state;
  if (!room || room.phase !== 'playing') return;
  updateHud();
  if (me() && !hasSubmitted() && serverNow() >= room.deadline) submitCurrent(true);
  if (room.hostId === state.uid) hostTick(state.code, room);
}

// ---------- 그림판 도구 ----------
function setupToolbar() {
  sketch = new Sketch($('#canvas'));
  const colors = $('#colors');
  const sizes = $('#sizes');
  const refresh = () => {
    colors.querySelectorAll('button').forEach((b) => b.classList.toggle('active', !sketch.eraser && b.dataset.color === sketch.color));
    sizes.querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === sketch.size));
    $('#tool-eraser').classList.toggle('active', sketch.eraser);
  };
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.dataset.color = c;
    b.setAttribute('aria-label', `색 ${c}`);
    b.addEventListener('click', () => { sketch.setColor(c); refresh(); });
    colors.appendChild(b);
  }
  SIZES.forEach((s, idx) => {
    const b = document.createElement('button');
    b.className = 'tool size';
    b.dataset.size = s;
    b.setAttribute('aria-label', ['얇게', '보통', '굵게'][idx]);
    const dot = document.createElement('i');
    dot.style.width = dot.style.height = `${6 + idx * 6}px`;
    b.appendChild(dot);
    b.addEventListener('click', () => { sketch.setSize(s); refresh(); });
    sizes.appendChild(b);
  });
  $('#tool-eraser').addEventListener('click', () => { sketch.setEraser(!sketch.eraser); refresh(); });
  $('#tool-undo').addEventListener('click', () => sketch.undo());
  $('#tool-clear').addEventListener('click', () => sketch.clear());
  refresh();
}

// ---------- 이벤트 ----------
function bindEvents() {
  const onEnter = (el, fn) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) fn(); });

  const requireName = () => {
    const name = myName();
    if (!name) { $('#home-error').textContent = '닉네임을 먼저 적어 주세요.'; $('#home-name').focus(); }
    return name;
  };

  let busy = false;
  const guard = (fn) => async () => {
    if (busy) return;
    busy = true;
    $('#home-error').textContent = '';
    try { await fn(); } catch (e) {
      if (!(e instanceof RoomError)) console.error(e);
      $('#home-error').textContent = e instanceof RoomError ? e.message : '연결에 실패했어요. 잠시 후 다시 시도해 주세요.';
    } finally { busy = false; }
  };

  const create = guard(async () => {
    const name = requireName();
    if (!name) return;
    const code = await createRoom(state.uid, name);
    enterRoom(code);
  });
  const join = guard(async () => {
    const name = requireName();
    if (!name) return;
    const code = normalizeCode($('#home-code').value);
    if (code.length !== 4) { $('#home-error').textContent = '방 코드 4글자를 입력해 주세요.'; return; }
    await joinRoom(code, state.uid, name);
    enterRoom(code);
  });

  $('#btn-create').addEventListener('click', create);
  $('#btn-join').addEventListener('click', join);
  onEnter($('#home-code'), join);
  $('#home-code').addEventListener('input', (e) => { e.target.value = normalizeCode(e.target.value); });

  $('#btn-share').addEventListener('click', async () => {
    const link = inviteLink(state.code);
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title: '텔레스트레이션', text: `방 코드 ${state.code}`, url: link });
      } else {
        await navigator.clipboard.writeText(link);
        toast('초대 링크를 복사했어요!');
      }
    } catch { /* 공유 취소 */ }
  });

  $('#btn-leave').addEventListener('click', async () => {
    const code = state.code;
    exitRoom('');
    try { await leaveRoom(code, state.uid); } catch (e) { console.warn(e); }
  });

  $('#set-draw').addEventListener('change', (e) => updateSettings(state.code, { drawSec: Number(e.target.value) }));
  $('#set-guess').addEventListener('change', (e) => updateSettings(state.code, { guessSec: Number(e.target.value) }));

  $('#btn-start').addEventListener('click', async () => {
    try { await startGame(state.code, state.room, state.words); } catch (e) { toast(e.message || '시작하지 못했어요.'); }
  });

  $('#word-submit').addEventListener('click', () => submitCurrent());
  onEnter($('#word-input'), () => submitCurrent());
  $('#draw-submit').addEventListener('click', () => submitCurrent());
  $('#guess-submit').addEventListener('click', () => submitCurrent());
  onEnter($('#guess-input'), () => submitCurrent());
  $('#word-custom-ok').addEventListener('click', () => pickWord($('#word-custom').value));
  onEnter($('#word-custom'), () => pickWord($('#word-custom').value));

  $('#result-lobby').addEventListener('click', () => backToLobby(state.code));
}

// ---------- 시작 ----------
async function init() {
  show('screen-home');
  bindEvents();
  setupToolbar();
  $('#home-name').value = localStorage.getItem('tele.name') || '';
  const urlCode = normalizeCode(new URLSearchParams(location.search).get('room'));
  if (urlCode) $('#home-code').value = urlCode;

  fetch('words.json').then((r) => r.json()).then((w) => { if (Array.isArray(w) && w.length >= 30) state.words = w; }).catch(() => {});

  if (!isConfigured) {
    $('#config-warning').hidden = false;
    $('#btn-create').disabled = true;
    $('#btn-join').disabled = true;
    return;
  }

  try {
    state.uid = await ensureAuth();
  } catch (e) {
    console.error(e);
    $('#home-error').textContent = '로그인에 실패했어요. Firebase 콘솔에서 익명 로그인을 켰는지 확인해 주세요.';
    return;
  }

  // 새로고침·재접속: 이미 그 방의 플레이어면 바로 복귀
  if (urlCode) {
    try {
      const snap = await get(roomRef(urlCode, `players/${state.uid}`));
      if (snap.exists()) {
        if (!myName()) $('#home-name').value = snap.val().name;
        await joinRoom(urlCode, state.uid, snap.val().name);
        enterRoom(urlCode);
      }
    } catch (e) { console.warn(e); }
  }
  setInterval(tick, 250);
}

init();
