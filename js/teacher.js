// 선생님 화면: 수업 로그인, 설정, 모둠 방 관리, 진행(방장 역할), 결과 발표
import { ensureAuth, isConfigured, onValue, ref, db, roomRef, serverNow } from './firebase.js';
import { normalizeClassCode, isClassCode, classRoomId, RoomError, MIN_CLASS_PLAYERS, MAX_PLAYERS } from './room.js';
import {
  getClass, isOwner, loginClass, createClass, saveClass, openRooms, closeRooms, claimRoomHost, kickPlayer,
  clearStartRequest, setWatching, warnPlayer, banPlayer, hidePage, moveSeat, rejectRejoin, liveRef,
  MAX_GROUPS,
} from './classroom.js';
import { startGame, hostTick, backToLobby, onlinePlayers, pageType, bookFor, readyState } from './game.js';
import { bookEntries } from './result.js';
import { describeWords, leaksAnswer, OLD_DEFAULT_MODELS } from './ai.js';
import {
  parseWordList, formatWordList, descKey, DEFAULT_HINTS, DEFAULT_TILES, DESC_MAX, survived,
} from './hints.js';
import { renderResult, resetResult } from './result.js';
import { keepScreenOn } from './wakelock.js';

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
  watching: null,   // 들여다보는 중인 roomId
  live: {},         // 들여다보는 모둠 학생들의 그리는 중 미리보기 (uid → {img|text, r, at})
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

/** 화면에 적힌 설정값 (저장 여부와 관계없이 이것이 기준) */
function formValues() {
  const { words, desc } = parseWordList($('#t-words').value, WORD_MAX);
  return {
    groups: Number($('#t-groups').value),
    settings: {
      drawSec: Number($('#t-draw').value),
      guessSec: Number($('#t-guess').value),
      guessMode: $('#t-mode').value,
      hints: Number($('#t-hints').value),
      tiles: Number($('#t-tiles').value),
    },
    words,
    desc,
    leaderStart: $('#t-leader').checked,
  };
}

const wordsFor = (words) => (words.length ? words : state.defaultWords);

// 설정은 바꾸는 즉시 자동 저장한다 (저장 버튼을 깜빡해도 적용되도록)
let saveTimer = null;
async function saveForm() {
  clearTimeout(saveTimer);
  if (!state.code) return;
  $('#t-save-status').textContent = '저장 중…';
  try {
    await saveClass(state.code, formValues());
    $('#t-save-status').textContent = '✓ 저장됨';
  } catch (e) {
    console.error(e);
    $('#t-save-status').textContent = '⚠ 저장 실패';
    throw e;
  }
}
function saveSoon() {
  $('#t-save-status').textContent = '입력 중…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveForm().catch(() => {}), 700);
}

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
  keepScreenOn(false);
  localStorage.removeItem(STORE_KEY);
  $('#t-dash').hidden = true;
  $('#t-present').hidden = true;
  $('#t-login').hidden = false;
  $('#t-logout').hidden = true;
}

// ---------- 대시보드 ----------
function leaveDashboard() {
  closeWatch();
  state.unsubs.forEach((off) => off());
  Object.assign(state, { unsubs: [], rooms: {}, code: null, cls: null, presenting: null });
  state.claimed.clear();
}

async function enterDashboard(code) {
  leaveDashboard();
  keepScreenOn(true);
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
    if (!formLoaded) {
      fillForm(cls);
      formLoaded = true;
      // 이 기능 이전에 만든 수업은 값이 없으므로 기본값(켜짐)을 저장
      if (cls.leaderStart === undefined) saveClass(code, { leaderStart: true }).catch(() => {});
    }
    if (prevGroups !== cls.groups) subscribeRooms();
    renderControls();
  }));
}

function fillForm(cls) {
  $('#t-groups').value = String(cls.groups);
  $('#t-draw').value = String(cls.settings.drawSec);
  $('#t-guess').value = String(cls.settings.guessSec);
  $('#t-mode').value = cls.settings.guessMode || 'free';
  $('#t-hints').value = String(cls.settings.hints ?? DEFAULT_HINTS);
  $('#t-tiles').value = String(cls.settings.tiles ?? DEFAULT_TILES);
  $('#t-words').value = formatWordList(cls.words, cls.desc);
  $('#t-leader').checked = cls.leaderStart !== false;
  updateWordCount();
}

function updateWordCount() {
  const { words, desc } = parseWordList($('#t-words').value, WORD_MAX);
  const d = Object.keys(desc).length;
  $('#t-words-count').textContent = words.length ? `(${words.length}개${d ? `, 설명 ${d}개` : ''})` : '(비어 있음 → 기본 제시어 사용)';
}

// ---------- AI 설명 힌트 (Google AI Studio · Gemini API, js/ai.js) ----------
const AI_KEY = 'tele.teacher.aiKey';
const AI_MODEL = 'tele.teacher.aiModel';
const AI_BATCH = 60;

async function aiFill() {
  const key = $('#t-ai-key').value.trim();
  const model = $('#t-ai-model').value.trim(); // 비우면 자동 선택
  const status = $('#t-ai-status');
  if (!key) { status.textContent = 'API 키를 먼저 넣어 주세요.'; return; }
  try { localStorage.setItem(AI_KEY, key); localStorage.setItem(AI_MODEL, model); } catch { /* 무시 */ }
  const { words, desc } = parseWordList($('#t-words').value, WORD_MAX);
  const need = words.filter((w) => !desc[descKey(w)]);
  if (!need.length) { status.textContent = words.length ? '모든 단어에 설명이 있어요.' : '제시어 목록이 비어 있어요.'; return; }
  const btn = $('#t-ai-fill');
  btn.disabled = true;
  let added = 0;
  let dropped = 0;
  let used = model;
  // 묶음마다 바로 저장한다 — 중간에 서버가 붐벼 멈춰도 그때까지 받은 설명은 남도록
  const saveSoFar = async () => {
    $('#t-words').value = formatWordList(words, desc);
    updateWordCount();
    await saveForm();
  };
  try {
    for (let i = 0; i < need.length; i += AI_BATCH) {
      status.textContent = `AI가 설명을 만드는 중… (${Math.min(i + AI_BATCH, need.length)}/${need.length})`;
      const res = await describeWords(need.slice(i, i + AI_BATCH), key, used, DESC_MAX - 15, (note) => { status.textContent = note; });
      const { got } = res;
      used = res.model;
      for (const w of need.slice(i, i + AI_BATCH)) {
        const d = typeof got[w] === 'string' ? got[w].replace(/\s+/g, ' ').replace(/[:：]/g, ',').trim().slice(0, DESC_MAX) : '';
        if (!d) continue;
        if (leaksAnswer(w, d)) { dropped++; continue; }
        desc[descKey(w)] = d;
        added++;
      }
      await saveSoFar();
    }
    status.textContent = `${added}개 채웠어요${dropped ? ` (정답이 드러난 ${dropped}개는 뺐어요)` : ''}. 읽어 보고 고쳐 주세요. (모델: ${used})`;
  } catch (e) {
    console.warn('ai', e);
    const kept = added ? ` 그 전까지 받은 ${added}개는 저장했어요. 다시 누르면 나머지만 채워요.` : '';
    status.textContent = `⚠ ${e instanceof SyntaxError ? 'AI 답을 읽지 못했어요. 다시 눌러 주세요.' : e.message}${kept}`;
  } finally {
    btn.disabled = false;
  }
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
      if (room && room.class === state.code) {
        handleStartRequest(id, room);
        handleRejoin(id, room);
        dropBannedFromLobby(id, room);
        // 제출이 들어올 때마다 바로 진행 여부를 확인한다. 창이 가려져 타이머가 느려져도 전원 제출이면 넘어가도록.
        if (room.phase === 'playing' && room.hostId === state.uid) hostTick(id, room);
      }
      renderRooms();
      renderControls();
      if (state.presenting === id) renderPresentation();
      if (state.watching === id) renderWatch();
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
          <button class="btn small" data-act="watch">👀 들여다보기</button>
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
        li.textContent = (room.banned && room.banned[uid] ? '🚫 ' : '') + p.name;
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
    const rs = readyState(room);
    const startBtn = card.querySelector('[data-act="start"]');
    startBtn.hidden = room.phase === 'playing';
    startBtn.textContent = room.phase === 'result' ? '▶ 다음 판' : '▶ 시작';
    startBtn.disabled = online < MIN_CLASS_PLAYERS;
    card.querySelector('[data-act="present"]').hidden = room.phase !== 'result';
    card.querySelector('[data-act="lobby"]').hidden = room.phase === 'lobby';
    const leader = onlinePlayers(room)[0];
    const leaderText = state.cls && state.cls.leaderStart !== false && leader ? ` · 👑 모둠장 ${room.players[leader].name}` : '';
    card.querySelector('.t-room-hint').textContent = room.phase === 'lobby'
      ? (online < MIN_CLASS_PLAYERS ? `${MIN_CLASS_PLAYERS}명 이상이면 시작할 수 있어요 (지금 ${online}명, 최대 ${MAX_PLAYERS}명)` : `${online}명 준비 완료`) + leaderText
      : room.phase === 'playing' ? pendingText(room)
        : `결과 보는 중 · 준비 ${rs.count}/${rs.ids.length}` + (rs.all ? ' ✓' + leaderText : '');
  }
}

/** 게임 중: 이번 차례를 아직 내지 않은 학생 (연결이 끊긴 학생은 따로 표시) */
function pendingText(room) {
  const done = (room.submitted && room.submitted[room.round]) || {};
  const players = room.players || {};
  const left = room.order.filter((uid) => players[uid] && !done[uid]);
  if (!left.length) return '모두 냈어요 ✓';
  const names = left.map((uid) => players[uid].name + (players[uid].online ? '' : '(연결 끊김)'));
  return `아직 안 낸 학생: ${names.join(', ')}`;
}

/** 모둠장이 누른 '게임 시작' 요청을 선생님 설정으로 처리한다 */
const handlingRequest = new Set();
async function handleStartRequest(id, room) {
  if (!room.startRequest || room.phase === 'playing' || room.hostId !== state.uid || handlingRequest.has(id)) return;
  handlingRequest.add(id);
  try {
    // 결과 화면에서 누른 '다음 판'은 모두 준비 완료일 때만
    if (onlinePlayers(room).length >= MIN_CLASS_PLAYERS && (room.phase === 'lobby' || readyState(room).all)) {
      await start(id);
      toast(`${room.group}모둠 모둠장이 게임을 시작했어요.`);
    } else {
      await clearStartRequest(id);
    }
  } catch (e) {
    console.error(e);
    await clearStartRequest(id).catch(() => {});
  } finally {
    handlingRequest.delete(id);
  }
}

async function start(id) {
  const room = state.rooms[id];
  if (!room || room.phase === 'playing') return;
  const { settings, words } = formValues();
  // 수업 방은 첫 제시어를 항상 선생님 목록(없으면 기본 목록)에서 고른다 — 인원이 홀수여도
  await startGame(id, room, wordsFor(words), { settings, minPlayers: MIN_CLASS_PLAYERS, choicesForAll: true });
}

async function onRoomAction(id, e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const room = state.rooms[id];
  try {
    if (btn.dataset.act === 'start') {
      const rs = readyState(room);
      if (room.phase === 'result' && !rs.all && !confirm(`아직 준비 안 한 학생이 있어요 (${rs.waiting.map((u) => room.players[u].name).join(', ')}). 다음 판을 시작할까요?`)) return;
      await start(id);
    } else if (btn.dataset.act === 'watch') openWatch(id);
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

/**
 * 기기·브라우저가 바뀌어 새 사람으로 들어온 학생의 자리 되찾기 요청.
 * 이름이 같고 연결이 끊긴 (강퇴되지 않은) 자리가 있으면 새 기기로 옮기고, 아니면 요청을 지운다.
 */
const handlingRejoin = new Set();
async function handleRejoin(id, room) {
  if (!room.rejoin || room.hostId !== state.uid) return;
  for (const [uid, req] of Object.entries(room.rejoin)) {
    const key = `${id}/${uid}`;
    if (handlingRejoin.has(key)) continue;
    handlingRejoin.add(key);
    try {
      const banned = room.banned || {};
      const players = room.players || {};
      const seat = Object.entries(players).find(([u, p]) => u !== uid && p.name === req.name && !p.online && !banned[u]);
      if (players[uid] || banned[uid] || Object.values(banned).includes(req.name) || !seat) {
        await rejectRejoin(id, uid);
      } else {
        await moveSeat(id, room, seat[0], uid);
        toast(`${room.group}모둠 ${req.name} 학생이 새 기기로 다시 들어왔어요.`);
      }
    } catch (e) {
      console.error('rejoin', e);
      await rejectRejoin(id, uid).catch(() => {});
    } finally {
      handlingRejoin.delete(key);
    }
  }
}

/** 게임 중에 강퇴한 학생은 자리만 남겨 두었다가, 대기실로 돌아오면 참가자 목록에서 뺀다 */
function dropBannedFromLobby(id, room) {
  if (room.phase !== 'lobby' || !room.banned || room.hostId !== state.uid) return;
  for (const uid of Object.keys(room.players || {})) {
    if (room.banned[uid]) kickPlayer(id, uid).catch(() => {});
  }
}

// ---------- 모둠 들여다보기 ----------
let liveOff = null;

function openWatch(id) {
  closeWatch();
  state.watching = id;
  state.live = {};
  setWatching(id, true).catch((e) => console.warn('watch', e));
  liveOff = onValue(liveRef(id), (snap) => { state.live = snap.val() || {}; renderWatch(); }, () => {});
  $('#t-dash').hidden = true;
  $('#t-watch').hidden = false;
  $('#t-watch-books').dataset.key = '';
  renderWatch();
  window.scrollTo(0, 0);
}

function closeWatch() {
  const id = state.watching;
  if (!id) return;
  state.watching = null;
  if (liveOff) { liveOff(); liveOff = null; }
  setWatching(id, false).catch(() => {});
  $('#t-watch').hidden = true;
  $('#t-dash').hidden = false;
}

const TASK_LABEL = { word: '제시어 고르는 중', draw: '그리는 중', guess: '맞히는 중' };

/** 게임 중 한 학생의 이번 차례: 무엇을 하는지와 (냈으면) 낸 페이지 */
function turnOf(room, uid) {
  const i = room.order.indexOf(uid);
  if (i < 0) return null;
  const N = room.order.length;
  const r = room.round;
  const b = bookFor(i, r, N);
  const book = (room.books && room.books[b]) || {};
  const type = pageType(r, N);
  let about = '';
  if (type === 'draw') {
    const prev = book.pages && book.pages[r - 1];
    about = r === 0 ? (book.word ? `그릴 것: ${book.word}` : '제시어 고르는 중') : `그릴 것: ${prev && prev.content ? prev.content : '(빈 답)'}`;
  } else if (type === 'guess') about = '앞사람 그림 보고 맞히는 중';
  const done = !!(room.submitted && room.submitted[r] && room.submitted[r][uid]);
  return { type, about, done, page: book.pages && book.pages[r] };
}

function previewEl(content, isImg) {
  const box = document.createElement('div');
  box.className = 'w-live' + (isImg ? '' : ' text');
  if (isImg && content) {
    const img = document.createElement('img');
    img.src = content;
    img.alt = '';
    box.appendChild(img);
  } else {
    box.textContent = content || '';
  }
  return box;
}

function renderWatch() {
  const id = state.watching;
  const room = state.rooms[id];
  if (!room) { closeWatch(); return; }
  $('#t-watch-title').textContent = `${room.group}모둠 들여다보기`;
  const st = statusText(room);
  $('#t-watch-badge').textContent = st.text;
  $('#t-watch-badge').className = `badge ${st.cls}`;

  const banned = room.banned || {};
  const players = room.players || {};
  const inGame = room.phase !== 'lobby' && room.order;
  const ids = inGame
    ? [...room.order, ...Object.keys(players).filter((u) => !room.order.includes(u))]
    : Object.keys(players).sort((a, b) => (players[a].joinedAt || 0) - (players[b].joinedAt || 0));

  const box = $('#t-watch-players');
  box.innerHTML = '';
  if (!ids.length) box.textContent = '아직 아무도 없어요.';
  for (const uid of ids) {
    const p = players[uid];
    if (!p) continue;
    const isBanned = !!banned[uid];
    const tile = document.createElement('div');
    tile.className = 'card w-player' + (isBanned ? ' banned' : p.online ? '' : ' offline');
    const name = document.createElement('div');
    name.className = 'w-name';
    const nm = document.createElement('span');
    nm.textContent = p.name;
    const tag = document.createElement('span');
    tag.className = 'tag' + (p.online && !isBanned ? '' : ' muted');
    name.append(nm, tag);
    const task = document.createElement('div');
    task.className = 'w-task';
    tile.append(name, task);

    if (isBanned) {
      tag.textContent = '🚫 강퇴됨';
    } else if (room.phase === 'playing' && room.order.includes(uid)) {
      const t = turnOf(room, uid);
      tag.textContent = t.done ? '✓ 냈어요' : p.online ? TASK_LABEL[t.type] : '연결 끊김';
      const used = Object.values((room.hintUse && room.hintUse[uid]) || {}).reduce((a, b) => a + (Number(b) || 0), 0);
      task.textContent = t.about + (used ? ` · 💡 힌트 ${used}개 씀` : '');
      if (t.done && t.page) {
        tile.appendChild(previewEl(t.page.hidden ? '(가림)' : t.page.content || '(빈 답)', t.page.type === 'draw' && !!t.page.content));
      } else {
        const lv = state.live[uid];
        const cur = lv && lv.r === room.round ? lv : null;
        if (t.type === 'draw') tile.appendChild(previewEl(cur && cur.img ? cur.img : '그리는 중인 그림이 곧 보여요', !!(cur && cur.img)));
        else tile.appendChild(previewEl(cur && cur.text ? `✏️ ${cur.text}` : '(아직 안 씀)', false));
      }
    } else if (room.phase === 'result') {
      tag.textContent = room.ready && room.ready[uid] ? '✅ 준비' : p.online ? '보는 중' : '연결 끊김';
    } else {
      tag.textContent = p.online ? (room.phase === 'playing' ? '다음 판부터' : '대기 중') : '연결 끊김';
    }

    if (!isBanned) {
      const actions = document.createElement('div');
      actions.className = 'w-actions';
      actions.innerHTML = '<button class="btn small" data-act="warn">⚠️ 경고</button><button class="btn small danger" data-act="ban">🚫 강퇴</button>';
      actions.querySelectorAll('button').forEach((b) => { b.dataset.uid = uid; });
      tile.appendChild(actions);
    }
    box.appendChild(tile);
  }

  // 스케치북: 지금까지 낸 페이지 (가리기용)
  const books = $('#t-watch-books');
  $('#t-watch-books-title').hidden = !inGame;
  if (!inGame) { books.innerHTML = ''; books.dataset.key = ''; return; }
  const N = room.order.length;
  const bkey = room.order.map((owner, b) => {
    const pages = (room.books && room.books[b] && room.books[b].pages) || {};
    return `${players[owner]?.name}:` + Object.entries(pages).map(([r, pg]) => `${r}.${pg.by}.${(pg.content || '').length}${pg.hidden ? 'h' : ''}`).join(',');
  }).join('|') + `:${N}:${room.phase}`;
  if (books.dataset.key === bkey) return;
  books.dataset.key = bkey;
  books.innerHTML = '';
  room.order.forEach((owner, b) => {
    const card = document.createElement('div');
    card.className = 'card w-book';
    const h = document.createElement('strong');
    h.textContent = `${players[owner] ? players[owner].name : '(나간 학생)'}의 스케치북` +
      (room.phase === 'result' && survived(room.books && room.books[b], N) ? ' 🏆 끝까지 살아남음' : '');
    const row = document.createElement('div');
    row.className = 'w-pages';
    const bookPages = (room.books && room.books[b] && room.books[b].pages) || {};
    bookEntries(room, b).forEach((e, idx) => {
      // 짝수 인원은 첫 칸이 제시어(따로 저장), 그 뒤가 라운드별 페이지
      const r = N % 2 === 0 ? idx - 1 : idx;
      if (r >= 0 && !bookPages[r]) return; // 아직 안 낸 페이지
      const cell = document.createElement('div');
      cell.className = 'w-page';
      const who = document.createElement('span');
      who.className = 'muted';
      who.textContent = `${idx + 1}. ${players[e.by] ? players[e.by].name : '?'}${e.hint ? ` 💡${e.hint}` : ''}`;
      cell.appendChild(who);
      if (e.type === 'draw' && e.content) {
        const img = document.createElement('img');
        img.src = e.content;
        img.alt = '';
        cell.appendChild(img);
      } else {
        const t = document.createElement('div');
        t.className = 'w-text' + (e.content ? '' : ' muted');
        t.textContent = e.content || (e.hidden ? '(가림)' : e.skipped ? '(건너뜀)' : '(빈 답)');
        cell.appendChild(t);
      }
      if (r >= 0 && e.content) {
        const hide = document.createElement('button');
        hide.className = 'btn small danger';
        hide.textContent = '🙈 가리기';
        hide.dataset.act = 'hide';
        hide.dataset.b = String(b);
        hide.dataset.r = String(r);
        cell.appendChild(hide);
      }
      row.appendChild(cell);
    });
    card.append(h, row);
    books.appendChild(card);
  });
}

async function onWatchAction(e) {
  const btn = e.target.closest('[data-act]');
  const id = state.watching;
  const room = state.rooms[id];
  if (!btn || !room) return;
  try {
    if (btn.dataset.act === 'warn') {
      const name = room.players[btn.dataset.uid]?.name;
      const msg = prompt(`${name} 학생 화면에 띄울 경고`, '선생님이 보고 있어요. 게임에 맞게 제대로 참여해 주세요!');
      if (!msg || !msg.trim()) return;
      await warnPlayer(id, btn.dataset.uid, msg.trim());
      toast(`${name} 학생에게 경고를 보냈어요.`);
    } else if (btn.dataset.act === 'ban') {
      const name = room.players[btn.dataset.uid]?.name;
      if (!confirm(`${name} 학생을 ${room.group}모둠에서 강퇴할까요?\n모둠 방을 새로 열 때까지 이 모둠에 다시 들어올 수 없고, 남은 차례는 건너뛰어요.`)) return;
      await banPlayer(id, room, btn.dataset.uid);
      toast(`${name} 학생을 강퇴했어요.`);
    } else if (btn.dataset.act === 'hide') {
      if (!confirm('이 그림(답)을 가릴까요? 다음 사람과 결과 발표에 나오지 않고, 되돌릴 수 없어요.')) return;
      await hidePage(id, btn.dataset.b, btn.dataset.r);
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
  const watched = state.watching && state.rooms[state.watching];
  if (watched && watched.phase === 'playing') {
    const st = statusText(watched);
    $('#t-watch-badge').textContent = st.text;
  }
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
  $('#t-words').addEventListener('input', () => { updateWordCount(); saveSoon(); });
  for (const sel of ['#t-groups', '#t-draw', '#t-guess', '#t-leader', '#t-mode', '#t-hints', '#t-tiles']) $(sel).addEventListener('change', () => saveForm().catch(() => {}));
  try {
    $('#t-ai-key').value = localStorage.getItem(AI_KEY) || '';
    const saved = localStorage.getItem(AI_MODEL) || '';
    $('#t-ai-model').value = OLD_DEFAULT_MODELS.includes(saved) ? '' : saved; // 예전 기본값은 자동 선택으로
  } catch { /* 무시 */ }
  $('#t-ai-fill').addEventListener('click', aiFill);

  $('#t-save').addEventListener('click', async () => {
    try {
      await saveForm();
      toast('설정을 저장했어요. 다음에 시작하는 게임부터 적용돼요.');
    } catch (e) { toast(errMsg(e)); }
  });

  $('#t-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(studentLink(state.code)); toast('학생용 링크를 복사했어요!'); } catch { prompt('이 링크를 복사하세요', studentLink(state.code)); }
  });

  $('#t-open').addEventListener('click', async () => {
    const hasPlayers = roomList().some(({ room }) => Object.keys(room.players || {}).length);
    if (hasPlayers && !confirm('지금 방에 있는 학생들이 모두 나가고 방이 새로 열려요. 계속할까요?')) return;
    try {
      // 화면에 적힌 설정(모둠 수·시간·제시어)을 저장하고 그대로 방을 연다
      const form = formValues();
      const { groups } = form;
      await saveForm();
      await openRooms(state.code, { ...state.cls, ...form }, state.uid);
      toast(`모둠 방 ${groups}개를 열었어요.`);
    } catch (e) { console.error(e); toast(errMsg(e)); }
  });

  $('#t-start-all').addEventListener('click', async () => {
    const ready = roomList().filter(({ room }) => room.phase === 'lobby' && onlinePlayers(room).length >= MIN_CLASS_PLAYERS);
    const waiting = roomList().filter(({ room }) => room.phase === 'lobby' && onlinePlayers(room).length < MIN_CLASS_PLAYERS);
    if (waiting.length && !confirm(`${waiting.map(({ room }) => room.group).join(', ')}모둠은 인원이 모자라 시작하지 않아요. 나머지 모둠을 시작할까요?`)) return;
    saveForm().catch(() => {});
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

  // 수업 방의 라운드 진행은 이 화면이 맡으므로, 게임 중에 닫으려 하면 경고한다
  window.addEventListener('beforeunload', (e) => {
    if (!Object.values(state.rooms).some((r) => r.phase === 'playing')) return;
    e.preventDefault();
    e.returnValue = '';
  });

  $('#t-present-close').addEventListener('click', closePresentation);
  $('#t-watch-close').addEventListener('click', closeWatch);
  $('#t-watch').addEventListener('click', onWatchAction);
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
