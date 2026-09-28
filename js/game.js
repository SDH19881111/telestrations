// 라운드 진행 규칙(pageType·로테이션)과 방장 전용 진행 로직
import { update, serverNow, roomRef } from './firebase.js';
import { MIN_PLAYERS } from './room.js';

const GRACE_MS = 2000;      // 마감 후 자동 제출을 기다리는 유예
const PICK_EXTRA_SEC = 15;  // 짝수 인원 1라운드: 제시어 고르는 시간 추가

/** r라운드(0부터)의 페이지 종류. 마지막 페이지는 항상 'guess'. */
export function pageType(r, N) {
  if (N % 2 === 0) return r % 2 === 0 ? 'draw' : 'guess';
  if (r === 0) return 'word';
  return r % 2 === 1 ? 'draw' : 'guess';
}

/** r라운드에 i번째 플레이어가 작성하는 스케치북 번호 */
export function bookFor(i, r, N) {
  return (((i - r) % N) + N) % N;
}

/** r라운드에 b번 스케치북을 작성하는 플레이어의 순번 */
export function writerIndex(b, r, N) {
  return (b + r) % N;
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

export function onlinePlayers(room) {
  return Object.entries(room.players || {})
    .filter(([, p]) => p.online)
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
      updates[`books/${b}/pages/${r}`] = {
        by: order[writerIndex(b, r, N)], type: pageType(r, N), content: '', skipped: true,
      };
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
  const waiting = room.order.filter((uid) => players[uid] && players[uid].online && !done[uid]);
  if (waiting.length === 0 || serverNow() > room.deadline + GRACE_MS) advance(code, room);
}

/** 내 제출: 페이지와 제출 표시를 한 번에 쓴다 */
export function submitPage(code, room, uid, content) {
  const i = room.order.indexOf(uid);
  const N = room.order.length;
  const r = room.round;
  const b = bookFor(i, r, N);
  return update(roomRef(code), {
    [`books/${b}/pages/${r}`]: { by: uid, type: pageType(r, N), content },
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
    assign: null, deadline: null, resultView: null,
  });
}
