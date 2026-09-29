// 화면 전환, 방 상태 구독
import { ensureAuth, isConfigured, onValue, get, set, ref, db, roomRef, serverNow, serverTimestamp } from './firebase.js';
import {
  createRoom, joinRoom, leaveRoom, startPresence, stopPresence, updateSettings, maybeClaimHost,
  normalizeCode, normalizeClassCode, normalizeRoomId, isClassCode, classRoomId, cleanName, RoomError,
  MIN_PLAYERS, MIN_CLASS_PLAYERS, MAX_PLAYERS,
} from './room.js';
import { getClass, groupInfo } from './classroom.js';
import {
  pageType, bookFor, startGame, hostTick, submitPage, chooseWord, backToLobby, onlinePlayers,
} from './game.js';
import { Sketch, COLORS, SIZES } from './canvas.js';
import { renderResult, resetResult } from './result.js';
import { keepScreenOn } from './wakelock.js';

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
  leaderStart: false, // 수업 방: 모둠장이 직접 시작할 수 있는지 (선생님 설정)
};

let sketch = null;

// ---------- 그리던 그림 임시 저장 ----------
// 제출 전 그림은 이 기기에만 있으므로, 튕기거나 새로고침해도 이어 그릴 수 있게 획을 localStorage에 둔다.
const DRAFT_PREFIX = 'tele.draft.';
let draftKey = null; // 지금 그리는 페이지의 저장 키 (방·라운드·스케치북)

function saveDraft() {
  if (!draftKey) return;
  try {
    if (sketch.isEmpty()) localStorage.removeItem(draftKey);
    else localStorage.setItem(draftKey, JSON.stringify(sketch.actions));
  } catch { /* 저장 공간이 없으면 포기 */ }
}

function loadDraft(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

/** 지금 그리는 페이지 말고는 모두 지운다 (key가 없으면 전부) */
function clearDrafts(keep = null) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(DRAFT_PREFIX) && k !== keep) localStorage.removeItem(k);
    }
  } catch { /* 무시 */ }
}

/** 그리기 화면에 들어올 때: 캔버스를 비우고, 같은 페이지를 그리던 기록이 있으면 되살린다 */
function startDrawing(m) {
  const key = `${DRAFT_PREFIX}${state.code}:${state.room.createdAt}:${state.room.order.join()}:${m.r}:${m.b}`;
  const saved = loadDraft(key);
  draftKey = null; // reset()이 부르는 저장이 기록을 지우지 않도록
  sketch.reset();
  draftKey = key;
  clearDrafts(key);
  if (saved && saved.length) {
    sketch.load(saved);
    toast('그리던 그림을 되살렸어요.');
  }
}

// ---------- 공통 ----------
function show(id) {
  for (const s of SCREENS) $('#' + s).hidden = s !== id;
  document.body.classList.toggle('drawing', id === 'screen-draw');
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

/**
 * 이 화면이 방장 역할(시작·진행·발표 넘기기)을 하는지.
 * 수업 방은 선생님 화면만 진행한다 — 같은 브라우저에서 선생님 화면과 학생 화면을 같이 열면
 * 둘이 같은 사용자로 인식되는데, 이때 학생 화면이 방장처럼 행동하지 않게 한다.
 */
function actsAsHost(room) {
  return !!room && room.hostId === state.uid && !room.class;
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
  keepScreenOn(true);
  state.unsub = onValue(roomRef(code), (snap) => onRoom(snap.val()), (err) => {
    console.error(err);
    exitRoom('방 정보를 불러오지 못했어요.');
  });
}

// 수업 방: 선생님이 '모둠장이 직접 시작'을 켰는지 구독
let leaderStartOff = null;
function watchLeaderStart(classCode) {
  if (leaderStartOff) return;
  leaderStartOff = onValue(ref(db, `classes/${classCode}/leaderStart`), (snap) => {
    state.leaderStart = snap.val() === true;
    if (state.room) render();
  }, () => {});
}

function exitRoom(message = '') {
  if (leaderStartOff) { leaderStartOff(); leaderStartOff = null; }
  state.leaderStart = false;
  if (state.unsub) state.unsub();
  stopPresence();
  keepScreenOn(false);
  $('#stall').hidden = true;
  Object.assign(state, { code: null, room: null, unsub: null, screenKey: '', sentRound: null });
  setUrlRoom(null);
  $('#hud').hidden = true;
  $('#group-pick').hidden = true;
  $('#home-main').hidden = false;
  show('screen-home');
  $('#home-error').textContent = message;
}

function onRoom(room) {
  if (!room) return exitRoom(state.room && state.room.class ? '선생님이 모둠 방을 닫았어요.' : '방이 사라졌어요.');
  if (!room.players || !room.players[state.uid]) return exitRoom(room.class ? '모둠에서 나왔어요. 다시 들어올 수 있어요.' : '방에서 나왔어요.');
  state.room = room;
  if (room.class) watchLeaderStart(room.class);
  if (room.phase !== 'playing') {
    state.sentRound = null;
    if (draftKey !== '') { draftKey = ''; clearDrafts(); } // 게임이 끝나면 한 번만 정리 (다음 판에 옛 그림이 살아나지 않게)
  }
  maybeClaimHost(state.code, room, state.uid);
  render();
  updateStall(room);
  if (actsAsHost(room)) hostTick(state.code, room);
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
    renderResult({ room, uid: actsAsHost(room) ? state.uid : null, code: state.code });
    return;
  }
  if (key.startsWith('wait')) { show('waiting'); updateHud(); return; }

  if (m.type === 'word') {
    if (changed) {
      $('#word-input').value = '';
      show('screen-word');
      if (!renderWordChoices(m)) $('#word-input').focus();
    }
  } else if (m.type === 'draw') {
    if (changed) { startDrawing(m); $('#word-custom').value = ''; show('screen-draw'); }
    renderDraw(m);
  } else {
    if (changed) { $('#guess-input').value = ''; show('screen-guess'); renderGuess(m); $('#guess-input').focus(); }
  }
  updateHud();
}

function renderLobby() {
  const { room, uid, code } = state;
  const isHost = actsAsHost(room);
  const isClass = !!room.class;
  $('#lobby-code').textContent = isClass ? `${room.group}모둠` : code;
  $('#lobby-code-label').textContent = isClass ? `수업 ${room.class}` : '방 코드';
  $('#btn-share').hidden = isClass;
  $('#lobby-settings').hidden = isClass;
  const entries = Object.entries(room.players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  const online = onlinePlayers(room).length;
  // 수업 방의 모둠장: 지금 접속해 있는 학생 중 가장 먼저 들어온 사람
  const leader = isClass ? onlinePlayers(room)[0] : null;
  const canLeaderStart = isClass && state.leaderStart && leader === uid;
  $('#lobby-count').textContent = `${entries.length}/${MAX_PLAYERS}`;

  const ul = $('#lobby-players');
  ul.innerHTML = '';
  for (const [id, p] of entries) {
    const li = document.createElement('li');
    li.className = p.online ? '' : 'offline';
    li.textContent = p.name;
    if (isClass ? id === leader : id === room.hostId) li.prepend('👑 ');
    if (isClass && id === leader) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '모둠장';
      li.appendChild(tag);
    }
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
  const min = isClass ? MIN_CLASS_PLAYERS : MIN_PLAYERS;
  const requested = isClass && !!room.startRequest;
  $('#btn-start').hidden = !(isHost || canLeaderStart) || playing;
  $('#btn-start').disabled = online < min || requested;
  $('#btn-start').textContent = requested ? '시작하는 중…' : '게임 시작';
  const leaderName = leader && room.players[leader] ? room.players[leader].name : '';
  let hint;
  if (playing) hint = '';
  else if (isHost || canLeaderStart) {
    hint = online < min ? `${min}명 이상 모이면 시작할 수 있어요 (지금 ${online}명)` : `${online}명이 함께해요. 시작해 볼까요?`;
    // 요청했는데 몇 초가 지나도 시작되지 않으면: 선생님 화면이 꺼져 있는 경우
    if (requested && serverNow() - (room.startRequest.at || 0) > 6000) hint = '선생님 화면이 켜져 있어야 시작돼요. 선생님께 말씀드려 주세요.';
  } else if (isClass) {
    hint = state.leaderStart && leaderName ? `모둠장 ${leaderName}(이)나 선생님이 시작하면 게임이 시작돼요.` : '선생님이 게임을 시작하기를 기다리는 중…';
  } else hint = '방장이 게임을 시작하기를 기다리는 중…';
  $('#lobby-hint').textContent = hint;
}

/** 수업 방에서는 첫 제시어를 선생님 목록의 후보 중에서 고른다 */
function classChoices(m) {
  const book = (state.room.books && state.room.books[m.b]) || {};
  return state.room.class && book.choices && book.choices.length ? book.choices : null;
}

function renderWordChoices(m) {
  const choices = classChoices(m);
  $('#word-screen-choices').hidden = !choices;
  $('#word-free').hidden = !!choices;
  $('#word-title').textContent = choices ? '제시어를 골라 주세요' : '제시어를 적어 주세요';
  $('#word-desc').textContent = choices ? '고른 단어를 다음 사람이 그림으로 그려요.' : '다음 사람이 이 단어를 그림으로 그려요. 너무 어렵지 않게!';
  const box = $('#word-screen-choices');
  box.innerHTML = '';
  for (const w of choices || []) {
    const btn = document.createElement('button');
    btn.className = 'btn choice';
    btn.textContent = w;
    btn.addEventListener('click', () => submitCurrent(false, w));
    box.appendChild(btn);
  }
  return !!choices;
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
  $('#word-custom-row').hidden = !!state.room.class && (book.choices || []).length > 0; // 수업 방은 목록에서만
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
async function submitCurrent(auto = false, chosen = null) {
  const m = me();
  const { room } = state;
  if (!m || room.phase !== 'playing' || hasSubmitted()) return;
  let content;
  if (m.type === 'draw') content = sketch.isEmpty() ? '' : sketch.toDataURL();
  else if (m.type === 'word' && classChoices(m)) content = chosen || classChoices(m)[0]; // 시간이 다 되면 첫 후보
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
    if (m.type === 'draw') { draftKey = null; clearDrafts(); }
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

// 마감이 지났는데도 다음 차례로 넘어가지 않을 때 (보통 2초 안에 넘어간다): 진행하는 화면이 꺼진 경우
const STALL_MS = 6000;
function updateStall(room) {
  const stalled = !!room && room.phase === 'playing' && !!room.deadline && serverNow() > room.deadline + STALL_MS;
  const el = $('#stall');
  if (stalled) {
    el.textContent = room.class
      ? '⚠️ 선생님 화면이 꺼져 있어 다음 차례로 넘어가지 않아요. 선생님께 알려 주세요!'
      : '⚠️ 방장의 연결을 기다리는 중이에요…';
  }
  el.hidden = !stalled;
}

// 250ms마다: 타이머 표시, 마감 시 자동 제출, 방장 진행 체크
function tick() {
  const { room } = state;
  if (room && room.phase === 'lobby' && room.startRequest && state.screenKey === 'lobby') renderLobby(); // 시작 요청 대기 안내 갱신
  updateStall(room);
  if (!room || room.phase !== 'playing') return;
  updateHud();
  if (me() && !hasSubmitted() && serverNow() >= room.deadline) submitCurrent(true);
  if (actsAsHost(room)) hostTick(state.code, room);
}

// ---------- 그림판 도구 ----------
function setupToolbar() {
  sketch = new Sketch($('#canvas'));
  sketch.onChange = saveDraft;
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
    const raw = $('#home-code').value.trim();
    if (/^[a-zA-Z]{4}$/.test(raw)) {
      const code = normalizeCode(raw);
      await joinRoom(code, state.uid, name);
      enterRoom(code);
      return;
    }
    const classCode = normalizeClassCode(raw);
    if (!isClassCode(classCode)) { $('#home-error').textContent = '방 코드(영문 4글자)나 선생님이 알려 준 수업 코드를 입력해 주세요.'; return; }
    await showGroups(classCode);
  });

  // 수업 코드 → 모둠 고르기
  async function showGroups(classCode) {
    const cls = await getClass(classCode);
    if (!cls) throw new RoomError('그런 수업 코드가 없어요. 선생님께 다시 확인해 주세요.');
    if (!cls.open) throw new RoomError('아직 수업 방이 열리지 않았어요. 선생님을 기다려 주세요.');
    const groups = await groupInfo(classCode, cls.groups, state.uid);
    $('#group-title').textContent = `${classCode} · 모둠을 고르세요`;
    const list = $('#group-list');
    list.innerHTML = '';
    for (const g of groups) {
      const btn = document.createElement('button');
      btn.className = 'btn choice group';
      const full = g.count >= MAX_PLAYERS;
      const playing = g.phase && g.phase !== 'lobby';
      // 게임 중이어도 내가 원래 있던 모둠이면 다시 들어갈 수 있다
      btn.disabled = !g.exists || (!g.mine && (full || playing));
      if (g.mine) btn.classList.add('mine');
      btn.innerHTML = '';
      const b = document.createElement('strong');
      b.textContent = `${g.n}모둠`;
      const small = document.createElement('small');
      small.textContent = !g.exists ? '닫힘' : g.mine ? (playing ? '게임 중 · 다시 들어가기' : '내 모둠') : playing ? '게임 중' : full ? '꽉 찼어요' : `${g.count}명`;
      btn.append(b, small);
      btn.addEventListener('click', guard(async () => {
        const name = requireName();
        if (!name) return;
        const id = classRoomId(classCode, g.n);
        await joinRoom(id, state.uid, name);
        $('#group-pick').hidden = true;
        enterRoom(id);
      }));
      list.appendChild(btn);
    }
    $('#home-main').hidden = true;
    $('#group-pick').hidden = false;
  }
  $('#group-back').addEventListener('click', () => { $('#group-pick').hidden = true; $('#home-main').hidden = false; });
  $('#group-refresh').addEventListener('click', guard(async () => showGroups(normalizeClassCode($('#home-code').value))));
  state.showGroups = guard(async () => { if (requireName()) await showGroups(normalizeClassCode($('#home-code').value)); });

  $('#btn-create').addEventListener('click', create);
  $('#btn-join').addEventListener('click', join);
  onEnter($('#home-code'), join);

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
    $('#btn-leave').disabled = true;
    try { await leaveRoom(code, state.uid); } catch (e) { console.warn(e); }
    $('#btn-leave').disabled = false;
    exitRoom('');
  });

  $('#set-draw').addEventListener('change', (e) => updateSettings(state.code, { drawSec: Number(e.target.value) }));
  $('#set-guess').addEventListener('change', (e) => updateSettings(state.code, { guessSec: Number(e.target.value) }));

  $('#btn-start').addEventListener('click', async () => {
    const room = state.room;
    if (room && room.class) {
      // 모둠장: 선생님 화면에 시작을 요청 → 선생님 제시어·설정으로 시작된다
      try {
        await set(roomRef(state.code, 'startRequest'), { by: state.uid, at: serverTimestamp() });
      } catch (e) { console.error(e); toast('시작하지 못했어요. 선생님께 말씀드려 주세요.'); }
      return;
    }
    if (!actsAsHost(room)) return;
    try { await startGame(state.code, state.room, state.words); } catch (e) { toast(e.message || '시작하지 못했어요.'); }
  });

  $('#word-submit').addEventListener('click', () => submitCurrent());
  onEnter($('#word-input'), () => submitCurrent());
  $('#draw-submit').addEventListener('click', () => submitCurrent());
  $('#guess-submit').addEventListener('click', () => submitCurrent());
  onEnter($('#guess-input'), () => submitCurrent());
  $('#word-custom-ok').addEventListener('click', () => pickWord($('#word-custom').value));
  onEnter($('#word-custom'), () => pickWord($('#word-custom').value));

  $('#result-lobby').addEventListener('click', () => { if (actsAsHost(state.room)) backToLobby(state.code); });
}

// ---------- 시작 ----------
async function init() {
  show('screen-home');
  bindEvents();
  setupToolbar();
  $('#home-name').value = localStorage.getItem('tele.name') || '';
  const params = new URLSearchParams(location.search);
  const urlCode = normalizeRoomId(params.get('room'));
  const urlClass = normalizeClassCode(params.get('class'));
  if (urlCode) $('#home-code').value = /^[A-Z]{4}$/.test(urlCode) ? urlCode : urlCode.split('-')[0];
  else if (urlClass) $('#home-code').value = urlClass;

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
  // 선생님이 준 링크(?class=3반)로 들어왔고 이름을 기억하고 있으면 바로 모둠 고르기
  if (!state.code && urlClass && myName()) state.showGroups();
  setInterval(tick, 250);
}

init();
