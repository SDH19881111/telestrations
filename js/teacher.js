// 선생님 화면: 수업 로그인, 설정, 모둠 방 관리, 진행(방장 역할), 결과 발표
import { ensureAuth, isConfigured, onValue, ref, db, roomRef, serverNow } from './firebase.js';
import { normalizeClassCode, isClassCode, classRoomId, RoomError, MIN_CLASS_PLAYERS, MAX_PLAYERS } from './room.js';
import {
  getClass, isOwner, loginClass, createClass, saveClass, openRooms, closeRooms, claimRoomHost, kickPlayer,
  MAX_GROUPS,
} from './classroom.js';
import { startGame, hostTick, backToLobby, onlinePlayers, pageType } from './game.js';
import { renderResult, resetResult } from './result.js';

const $ = (sel) => document.querySelector(sel);
const STORE_KEY = 'tele.teacher.class';
const WORD_MAX = 20;

const state = {
  uid: null,
  code: null,
  cls: null,
  rooms: {},       // roomId → room
  unsubs: [],
  claimed: new Set(),
  presenting: null, // 발표 중인 roomId
  defaultWords: [],
};

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

const errMsg = (e) => (e instanceof RoomError || e.message?.startsWith('최소') ? e.message : '처리하지 못했어요. 인터넷 연결을 확인해 주세요.');

function studentLink(code) {
  const url = new URL('./', location.href);
  if (new URLSearchParams(location.search).has('emulator')) url.searchParams.set('emulator', '1');
  url.searchParams.set('class', code);
  return url.toString();
}

function parseWords(text) {
  const words = text.split(/[\n,]/).map((w) => w.trim().slice(0, WORD_MAX)).filter(Boolean);
  return [...new Set(words)].slice(0, 500);
}

const wordsFor = () => (state.cls.words && state.cls.words.length ? state.cls.words : state.defaultWords);

// ---------- 로그인 ----------
async function login() {
  const code = normalizeClassCode($('#t-code').value);
  const pass = $('#t-pass').value;
  const err = $('#t-login-error');
  err.textContent = '';
  if (!isClassCode(code)) { err.textContent = '수업 코드는 한글·영문·숫자 2~10자로 정해 주세요.'; return; }
  if (pass.length < 4) { err.textContent = '비밀번호를 4자 이상 입력해 주세요.'; return; }
  $('#t-login-btn').disabled = true;
  try {
    const existing = await getClass(code);
    if (existing) {
      await loginClass(code, pass, state.uid);
    } else {
      if (!confirm(`'${code}' 수업을 새로 만들까요?\n이 비밀번호를 기억해 두세요. 다음 수업에도 같은 코드와 비밀번호로 들어옵니다.`)) return;
      await createClass(code, pass, state.uid);
    }
    $('#t-pass').value = '';
    await enterDashboard(code);
  } catch (e) {
    if (!(e instanceof RoomError)) console.error(e);
    err.textContent = errMsg(e);
  } finally {
    $('#t-login-btn').disabled = false;
  }
}

function logout() {
  leaveDashboard();
  localStorage.removeItem(STORE_KEY);
  $('#t-dash').hidden = true;
  $('#t-present').hidden = true;
  $('#t-login').hidden = false;
  $('#t-logout').hidden = true;
}

// ---------- 대시보드 ----------
function leaveDashboard() {
  state.unsubs.forEach((off) => off());
  Object.assign(state, { unsubs: [], rooms: {}, code: null, cls: null, presenting: null });
  state.claimed.clear();
}

async function enterDashboard(code) {
  leaveDashboard();
  state.code = code;
  localStorage.setItem(STORE_KEY, code);
  $('#t-login').hidden = true;
  $('#t-dash').hidden = false;
  $('#t-logout').hidden = false;
  $('#t-code-big').textContent = code;
  $('#t-code-inline').textContent = code;
  $('#t-url').textContent = new URL('./', location.href).host + new URL('./', location.href).pathname;

  let formLoaded = false;
  state.unsubs.push(onValue(ref(db, `classes/${code}`), (snap) => {
    const cls = snap.val();
    if (!cls) return;
    const prevGroups = state.cls ? state.cls.groups : null;
    state.cls = cls;
    if (!formLoaded) { fillForm(cls); formLoaded = true; }
    if (prevGroups !== cls.groups) subscribeRooms();
    renderControls();
  }));
}

function fillForm(cls) {
  $('#t-groups').value = String(cls.groups);
  $('#t-draw').value = String(cls.settings.drawSec);
  $('#t-guess').value = String(cls.settings.guessSec);
  $('#t-words').value = (cls.words || []).join('\n');
  updateWordCount();
}

function updateWordCount() {
  const n = parseWords($('#t-words').value).length;
  $('#t-words-count').textContent = n ? `(${n}개)` : '(비어 있음 → 기본 제시어 사용)';
}

let roomUnsubs = [];
function subscribeRooms() {
  roomUnsubs.forEach((off) => off());
  roomUnsubs = [];
  state.rooms = {};
  for (let n = 1; n <= MAX_GROUPS; n++) {
    const id = classRoomId(state.code, n);
    const off = onValue(roomRef(id), (snap) => {
      const room = snap.val();
      if (room && room.class === state.code) {
        state.rooms[id] = room;
        // 다른 기기에서 로그인했다면 이 화면이 진행권을 가져온다 (방마다 한 번)
        if (room.hostId !== state.uid && !state.claimed.has(id)) {
          state.claimed.add(id);
          claimRoomHost(id, state.uid).catch((e) => console.warn('claim', e));
        }
      } else {
        delete state.rooms[id];
      }
      renderRooms();
      renderControls();
      if (state.presenting === id) renderPresentation();
    });
    roomUnsubs.push(off);
  }
  state.unsubs.push(() => { roomUnsubs.forEach((off) => off()); roomUnsubs = []; });
}

function roomList() {
  return Object.entries(state.rooms)
    .map(([id, room]) => ({ id, room }))
    .sort((a, b) => a.room.group - b.room.group);
}

function renderControls() {
  if (!state.cls) return;
  const list = roomList();
  const open = state.cls.open && list.length > 0;
  $('#t-open').textContent = open ? '🔄 모둠 방 새로 열기 (초기화)' : '🚪 모둠 방 열기';
  $('#t-start-all').disabled = !list.some(({ room }) => room.phase === 'lobby' && onlinePlayers(room).length >= MIN_CLASS_PLAYERS);
  $('#t-lobby-all').disabled = !list.some(({ room }) => room.phase !== 'lobby');
  $('#t-close').disabled = !open;
  const total = list.reduce((sum, { room }) => sum + Object.keys(room.players || {}).length, 0);
  $('#t-status').textContent = open
    ? `모둠 ${list.length}개 열림 · 학생 ${total}명 접속`
    : '아직 방이 열리지 않았어요. 설정을 확인하고 "모둠 방 열기"를 누르세요.';
  if (open && state.cls.groups !== list.length) {
    $('#t-status').textContent += ` · 모둠 수를 ${state.cls.groups}개로 바꾸려면 "새로 열기"를 누르세요`;
  }
}

function statusText(room) {
  if (room.phase === 'lobby') return { text: '대기 중', cls: 'lobby' };
  if (room.phase === 'result') return { text: '결과 보기', cls: 'result' };
  const N = room.order.length;
  const done = Object.keys((room.submitted && room.submitted[room.round]) || {}).length;
  const remain = Math.max(0, Math.ceil((room.deadline - serverNow()) / 1000));
  const label = { word: '제시어', draw: '그리기', guess: '추측' }[pageType(room.round, N)];
  return { text: `${room.round + 1}/${N} ${label} · 제출 ${done}/${N} · ⏱${remain}`, cls: 'playing' };
}

function renderRooms() {
  const box = $('#t-rooms');
  const list = roomList();
  // 카드 구조가 바뀔 때만 다시 만들고, 나머지는 내용만 갱신
  const key = list.map(({ id }) => id).join();
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = '';
    for (const { id } of list) {
      const card = document.createElement('div');
      card.className = 'card t-room';
      card.dataset.id = id;
      card.innerHTML = `
        <div class="row between"><h2 class="t-room-name"></h2><span class="badge"></span></div>
        <ul class="players small-players"></ul>
        <p class="muted t-room-hint"></p>
        <div class="row wrap">
          <button class="btn small primary" data-act="start">▶ 시작</button>
          <button class="btn small" data-act="present">📺 결과 발표</button>
          <button class="btn small ghost" data-act="lobby">↺ 대기실로</button>
        </div>`;
      card.addEventListener('click', (e) => onRoomAction(id, e));
      box.appendChild(card);
    }
  }
  for (const { id, room } of list) {
    const card = box.querySelector(`[data-id="${CSS.escape(id)}"]`);
    card.querySelector('.t-room-name').textContent = `${room.group}모둠`;
    const st = statusText(room);
    const badge = card.querySelector('.badge');
    badge.textContent = st.text;
    badge.className = `badge ${st.cls}`;

    const ul = card.querySelector('ul');
    const players = Object.entries(room.players || {}).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
    const pkey = players.map(([u, p]) => `${u}:${p.name}:${p.online}`).join('|') + room.phase;
    if (ul.dataset.key !== pkey) {
      ul.dataset.key = pkey;
      ul.innerHTML = '';
      for (const [uid, p] of players) {
        const li = document.createElement('li');
        li.className = p.online ? '' : 'offline';
        li.textContent = p.name;
        if (room.phase === 'lobby') {
          const x = document.createElement('button');
          x.className = 'kick';
          x.title = `${p.name} 내보내기`;
          x.setAttribute('aria-label', x.title);
          x.textContent = '✕';
          x.dataset.act = 'kick';
          x.dataset.uid = uid;
          li.appendChild(x);
        }
        ul.appendChild(li);
      }
      if (!players.length) {
        const li = document.createElement('li');
        li.className = 'offline';
        li.textContent = '아직 아무도 없어요';
        ul.appendChild(li);
      }
    }
    const online = onlinePlayers(room).length;
    card.querySelector('[data-act="start"]').hidden = room.phase !== 'lobby';
    card.querySelector('[data-act="start"]').disabled = online < MIN_CLASS_PLAYERS;
    card.querySelector('[data-act="present"]').hidden = room.phase !== 'result';
    card.querySelector('[data-act="lobby"]').hidden = room.phase === 'lobby';
    card.querySelector('.t-room-hint').textContent = room.phase === 'lobby'
      ? (online < MIN_CLASS_PLAYERS ? `${MIN_CLASS_PLAYERS}명 이상이면 시작할 수 있어요 (지금 ${online}명, 최대 ${MAX_PLAYERS}명)` : `${online}명 준비 완료`)
      : '';
  }
}

async function start(id) {
  const room = state.rooms[id];
  if (!room || room.phase !== 'lobby') return;
  await startGame(id, room, wordsFor(), { settings: state.cls.settings, minPlayers: MIN_CLASS_PLAYERS });
}

async function onRoomAction(id, e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const room = state.rooms[id];
  try {
    if (btn.dataset.act === 'start') await start(id);
    else if (btn.dataset.act === 'present') openPresentation(id);
    else if (btn.dataset.act === 'lobby') {
      if (room.phase === 'playing' && !confirm(`${room.group}모둠 게임을 중단하고 대기실로 돌아갈까요?`)) return;
      await backToLobby(id);
    } else if (btn.dataset.act === 'kick') {
      const name = room.players[btn.dataset.uid]?.name;
      if (confirm(`${name} 학생을 ${room.group}모둠에서 내보낼까요?`)) await kickPlayer(id, btn.dataset.uid);
    }
  } catch (err) {
    console.error(err);
    toast(errMsg(err));
  }
}

// ---------- 발표 모드 ----------
function openPresentation(id) {
  state.presenting = id;
  resetResult();
  $('#t-dash').hidden = true;
  $('#t-present').hidden = false;
  renderPresentation();
  window.scrollTo(0, 0);
}

function closePresentation() {
  state.presenting = null;
  $('#t-present').hidden = true;
  $('#t-dash').hidden = false;
}

function renderPresentation() {
  const id = state.presenting;
  const room = state.rooms[id];
  if (!room || room.phase !== 'result') { closePresentation(); return; }
  $('#t-present-title').textContent = `${room.group}모둠 결과`;
  renderResult({ room, uid: state.uid, code: id });
  $('#result-follow').hidden = true;
}

// ---------- 진행 타이머 ----------
function tick() {
  for (const { id, room } of roomList()) {
    if (room.phase === 'playing' && room.hostId === state.uid) hostTick(id, room);
  }
  if (Object.values(state.rooms).some((r) => r.phase === 'playing')) renderRooms();
}

// ---------- 이벤트 ----------
function bind() {
  $('#t-login-btn').addEventListener('click', login);
  $('#t-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) login(); });
  $('#t-logout').addEventListener('click', logout);

  const groups = $('#t-groups');
  for (let n = 1; n <= MAX_GROUPS; n++) {
    const o = document.createElement('option');
    o.value = String(n);
    o.textContent = `${n}모둠`;
    groups.appendChild(o);
  }
  $('#t-words').addEventListener('input', updateWordCount);

  $('#t-save').addEventListener('click', async () => {
    const words = parseWords($('#t-words').value);
    try {
      await saveClass(state.code, {
        groups: Number($('#t-groups').value),
        settings: { drawSec: Number($('#t-draw').value), guessSec: Number($('#t-guess').value) },
        words,
      });
      $('#t-words').value = words.join('\n');
      updateWordCount();
      toast('설정을 저장했어요. 다음에 시작하는 게임부터 적용돼요.');
    } catch (e) { console.error(e); toast(errMsg(e)); }
  });

  $('#t-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(studentLink(state.code)); toast('학생용 링크를 복사했어요!'); } catch { prompt('이 링크를 복사하세요', studentLink(state.code)); }
  });

  $('#t-open').addEventListener('click', async () => {
    const hasPlayers = roomList().some(({ room }) => Object.keys(room.players || {}).length);
    if (hasPlayers && !confirm('지금 방에 있는 학생들이 모두 나가고 방이 새로 열려요. 계속할까요?')) return;
    try {
      // 저장 안 한 모둠 수·시간 변경도 함께 반영
      const groups = Number($('#t-groups').value);
      const settings = { drawSec: Number($('#t-draw').value), guessSec: Number($('#t-guess').value) };
      await saveClass(state.code, { groups, settings });
      await openRooms(state.code, { ...state.cls, groups, settings }, state.uid);
      toast(`모둠 방 ${groups}개를 열었어요.`);
    } catch (e) { console.error(e); toast(errMsg(e)); }
  });

  $('#t-start-all').addEventListener('click', async () => {
    const ready = roomList().filter(({ room }) => room.phase === 'lobby' && onlinePlayers(room).length >= MIN_CLASS_PLAYERS);
    const waiting = roomList().filter(({ room }) => room.phase === 'lobby' && onlinePlayers(room).length < MIN_CLASS_PLAYERS);
    if (waiting.length && !confirm(`${waiting.map(({ room }) => room.group).join(', ')}모둠은 인원이 모자라 시작하지 않아요. 나머지 모둠을 시작할까요?`)) return;
    for (const { id } of ready) {
      try { await start(id); } catch (e) { console.error(e); toast(errMsg(e)); }
    }
  });

  $('#t-lobby-all').addEventListener('click', async () => {
    if (!confirm('모든 모둠을 대기실로 돌려보낼까요? 진행 중인 게임은 중단돼요.')) return;
    for (const { id, room } of roomList()) if (room.phase !== 'lobby') await backToLobby(id).catch((e) => console.error(e));
  });

  $('#t-close').addEventListener('click', async () => {
    if (!confirm('모든 모둠 방을 닫고 수업을 끝낼까요? 학생들은 첫 화면으로 돌아가요.')) return;
    try { await closeRooms(state.code); toast('수업을 끝냈어요.'); } catch (e) { console.error(e); toast(errMsg(e)); }
  });

  $('#t-present-close').addEventListener('click', closePresentation);
  $('#result-lobby').addEventListener('click', async () => {
    const id = state.presenting;
    closePresentation();
    await backToLobby(id).catch((e) => console.error(e));
  });
}

async function init() {
  bind();
  fetch('words.json').then((r) => r.json()).then((w) => { if (Array.isArray(w)) state.defaultWords = w; }).catch(() => {});
  if (!isConfigured) { $('#t-login-error').textContent = 'Firebase 설정이 필요해요 (README 참고).'; return; }
  try {
    state.uid = await ensureAuth();
  } catch (e) {
    console.error(e);
    $('#t-login-error').textContent = '로그인에 실패했어요. Firebase 익명 로그인이 켜져 있는지 확인해 주세요.';
    return;
  }
  const saved = localStorage.getItem(STORE_KEY);
  if (saved) {
    $('#t-code').value = saved;
    if (await isOwner(saved, state.uid)) await enterDashboard(saved);
  }
  setInterval(tick, 500);
}

init();
