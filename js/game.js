// 라운드 진행 규칙(pageType·로테이션)과 방장 전용 진행 로직
import { update, set, remove, serverNow, roomRef } from './firebase.js';
import { MIN_PLAYERS } from './room.js';

const GRACE_MS = 2000;      // 마감 후 자동 제출을 기다리는 유예
const PICK_EXTRA_SEC = 15;  // 짝수 인원 1라운드: 제시어 고르는 시간 추가
const RECONNECT_WAIT_MS = 10000; // 연결이 끊긴 지 이만큼 안 된 사람은 (마감 전까지) 돌아오길 기다린다

/** r라운드(0부터)의 페이지 종류. 마지막 페이지는 항상 'guess'. */
export function pageType(r, N) {
  if (N % 2 === 0) return r % 2 === 0 ? 'draw' : 'guess';
  if (r === 0) return 'word';
  return r % 2 === 1 ? 'draw' : 'guess';
}

/**
 * r라운드에 스케치북이 주인에게서 몇 칸 옆 사람에게 가 있는지: 0, 1, N-1, 2, N-2, 3, …
 * - N라운드 동안 모든 스케치북이 모든 사람을 정확히 한 번씩 거친다 (자기 스케치북은 0라운드뿐)
 * - 매번 넘어가는 칸 수가 달라서, 맞힐 때마다 다른 친구가 그린 그림을 받는다
 *   (한 칸씩만 넘기면 늘 바로 앞 친구의 그림만 맞히게 된다)
 */
export function passOffset(r, N) {
  if (r === 0) return 0;
  return r % 2 === 1 ? (r + 1) / 2 : N - r / 2;
}

/** r라운드에 i번째 플레이어가 작성하는 스케치북 번호 */
export function bookFor(i, r, N) {
  return (((i - passOffset(r, N)) % N) + N) % N;
}

/** r라운드에 b번 스케치북을 작성하는 플레이어의 순번 */
export function writerIndex(b, r, N) {
  return (b + passOffset(r, N)) % N;
}

export function roundSeconds(r, N, settings) {
  const type = pageType(r, N);
  if (type === 'draw') return settings.drawSec + (r === 0 ? PICK_EXTRA_SEC : 0);
  return settings.guessSec;
}

/** 보안 규칙 검사용: 이번 라운드에 각 uid가 쓸 수 있는 스케치북 번호(문자열) */
function assignment(order, r) {
  const N = order.length;
  const a = {};
  order.forEach((uid, i) => { a[uid] = String(bookFor(i, r, N)); });
  return a;
}

function roundFields(order, r, settings) {
  return {
    round: r,
    roundKey: String(r),
    assign: assignment(order, r),
    deadline: serverNow() + roundSeconds(r, order.length, settings) * 1000,
  };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const isBanned = (room, uid) => !!(room.banned && room.banned[uid]);

/** 지금 접속 중인 참가자 (선생님이 강퇴한 학생 제외), 들어온 순서대로 */
export function onlinePlayers(room) {
  return Object.entries(room.players || {})
    .filter(([uid, p]) => p.online && !isBanned(room, uid))
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
    .map(([uid]) => uid);
}

/** 제시어 후보: 스케치북마다 3개. 단어가 모자라면(선생님이 짧은 목록을 넣은 경우) 다시 섞어서 이어 붙인다. */
function wordChoices(words, N) {
  const list = [...new Set(words.filter(Boolean))];
  if (!list.length) return [];
  let pool = [];
  while (pool.length < N * 3) pool = pool.concat(shuffle(list));
  return Array.from({ length: N }, (_, i) => {
    const picked = [];
    for (let k = i * 3; picked.length < Math.min(3, list.length) && k < pool.length; k++) {
      if (!picked.includes(pool[k])) picked.push(pool[k]);
    }
    return picked;
  });
}

/**
 * 게임 시작 (방장 전용).
 * opts.settings: 시작하면서 적용할 시간 설정 (선생님 화면), opts.minPlayers: 최소 인원,
 * opts.choicesForAll: 인원과 관계없이 모든 스케치북에 제시어 후보를 준다 (수업 방)
 */
export async function startGame(code, room, words, opts = {}) {
  const min = opts.minPlayers || MIN_PLAYERS;
  const ids = onlinePlayers(room);
  if (ids.length < min) throw new Error(`최소 ${min}명이 있어야 시작할 수 있어요.`);
  const settings = opts.settings || room.settings;
  const order = shuffle(ids);
  const N = order.length;
  // 짝수 인원은 1라운드에 제시어를 고른다. 수업 방(choicesForAll)은 홀수 인원도 목록에서 고른다.
  const choices = N % 2 === 0 || opts.choicesForAll ? wordChoices(words, N) : [];
  const books = {};
  order.forEach((uid, i) => {
    books[i] = { owner: uid };
    if (choices[i] && choices[i].length) books[i].choices = choices[i];
  });
  lastAdvanced.delete(code);
  await update(roomRef(code), {
    phase: 'playing',
    settings,
    order,
    books,
    submitted: null,
    resultView: null,
    startRequest: null,
    ready: null,
    hintUse: null,
    ...roundFields(order, 0, settings),
  });
}

const lastAdvanced = new Map(); // 방별로 이미 넘긴 라운드 (중복 진행 방지)

/** 미제출 페이지를 '(건너뜀)'으로 채우고 다음 라운드(또는 결과)로 넘긴다. */
async function advance(code, room) {
  const r = room.round;
  const key = `${room.order.join()}:${r}`;
  if (lastAdvanced.get(code) === key) return;
  lastAdvanced.set(code, key);

  const { order } = room;
  const N = order.length;
  const books = room.books || {};
  const updates = {};
  for (let b = 0; b < N; b++) {
    const book = books[b] || {};
    if (!book.pages || !book.pages[r]) {
      const type = pageType(r, N);
      const by = order[writerIndex(b, r, N)];
      // 제시어를 고를 차례에 빠졌으면 후보 첫 번째로 채운다 (다음 사람이 빈 제시어를 받지 않게)
      updates[`books/${b}/pages/${r}`] = type === 'word' && book.choices && book.choices.length
        ? { by, type, content: book.choices[0] }
        : { by, type, content: '', skipped: true };
    }
    if (r === 0 && N % 2 === 0 && !book.word) {
      updates[`books/${b}/word`] = (book.choices && book.choices[0]) || '(건너뜀)';
    }
  }
  if (r + 1 >= N) {
    Object.assign(updates, {
      phase: 'result', resultView: { book: 0, step: 0 }, deadline: null, assign: null, roundKey: null,
    });
  } else {
    Object.assign(updates, roundFields(order, r + 1, room.settings));
  }
  try {
    await update(roomRef(code), updates);
  } catch (e) {
    console.warn('advance', e);
    lastAdvanced.delete(code);
  }
}

/** 방장 클라이언트가 주기적으로 호출: 전원 제출 또는 마감+유예 시 다음 라운드 */
export function hostTick(code, room) {
  if (room.phase !== 'playing' || !room.order) return;
  const r = room.round;
  const done = (room.submitted && room.submitted[r]) || {};
  const players = room.players || {};
  const now = serverNow();
  // 방금 끊긴 사람(와이파이 순간 끊김 등)은 바로 건너뛰지 않고 잠깐 기다린다. 마감이 지나면 어차피 넘어간다.
  const waiting = room.order.filter((uid) => {
    const p = players[uid];
    return p && !done[uid] && !isBanned(room, uid) && (p.online || (p.offAt && now - p.offAt < RECONNECT_WAIT_MS));
  });
  if (waiting.length === 0 || now > room.deadline + GRACE_MS) advance(code, room);
}

/** 내 제출: 페이지와 제출 표시를 한 번에 쓴다 */
export function submitPage(code, room, uid, content, extra = {}) {
  const i = room.order.indexOf(uid);
  const N = room.order.length;
  const r = room.round;
  const b = bookFor(i, r, N);
  return update(roomRef(code), {
    [`books/${b}/pages/${r}`]: { by: uid, type: pageType(r, N), content, ...extra },
    [`submitted/${r}/${uid}`]: true,
  });
}

export function chooseWord(code, room, uid, word) {
  const i = room.order.indexOf(uid);
  return update(roomRef(code, `books/${i}`), { word });
}

export function setResultView(code, view) {
  return update(roomRef(code), { resultView: view });
}

export function backToLobby(code) {
  lastAdvanced.delete(code);
  return update(roomRef(code), {
    phase: 'lobby', order: null, books: null, submitted: null, round: null, roundKey: null,
    assign: null, deadline: null, resultView: null, startRequest: null, ready: null, hintUse: null,
  });
}

/** 결과 화면의 준비 상태: 지금 접속 중인 참가자 전원이 '준비 완료'를 눌렀는지 */
export function readyState(room) {
  const ids = onlinePlayers(room);
  const ready = room.ready || {};
  const waiting = ids.filter((uid) => !ready[uid]);
  return { ids, count: ids.length - waiting.length, waiting, all: ids.length > 0 && waiting.length === 0 };
}

export function setReady(code, uid, on) {
  return on ? set(roomRef(code, `ready/${uid}`), true) : remove(roomRef(code, `ready/${uid}`));
}

/** 힌트 사용: 이번 라운드에 연 힌트 단계 수 (1~3) */
export function submitHintUse(code, uid, round, level) {
  return set(roomRef(code, `hintUse/${uid}/${round}`), level);
}
