// 방 만들기·입장·로비·접속 상태
import {
  db, ref, get, set, update, remove, runTransaction, onValue, onDisconnect,
  serverTimestamp, serverNow, roomRef,
} from './firebase.js';

export const MIN_PLAYERS = 4;
export const MIN_CLASS_PLAYERS = 3; // 수업 모둠은 3명부터
export const MAX_PLAYERS = 10;
export const NAME_MAX = 10;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 헷갈리는 I, O 제외
const STALE_MS = 12 * 60 * 60 * 1000; // 12시간 지난 방은 새 방으로 덮어쓸 수 있음

export const DEFAULT_SETTINGS = { drawSec: 60, guessSec: 30 };

export class RoomError extends Error {}

function randomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export function normalizeCode(code) {
  return (code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

/** 수업 코드: 한글·영문 대문자·숫자 2~10자 (예: 3반, SCIENCE1) */
export function normalizeClassCode(code) {
  return (code || '').toUpperCase().replace(/[^가-힣A-Z0-9]/g, '').slice(0, 10);
}

export const isClassCode = (code) => /^[가-힣A-Z0-9]{2,10}$/.test(code);
export const classRoomId = (classCode, group) => `${classCode}-${group}`;

/** URL 등에서 온 방 아이디 검사: 일반 방(ABCD) 또는 수업 모둠 방(3반-2) */
export function normalizeRoomId(id) {
  const s = (id || '').trim().toUpperCase();
  if (/^[A-Z]{4}$/.test(s)) return s;
  if (/^[가-힣A-Z0-9]{2,10}-\d{1,2}$/.test(s)) return s;
  return '';
}

export function cleanName(name) {
  return (name || '').trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
}

export async function createRoom(uid, name) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    const now = serverNow();
    const result = await runTransaction(roomRef(code), (cur) => {
      if (cur && cur.createdAt > now - STALE_MS) return; // 사용 중인 코드 → 중단
      return {
        hostId: uid,
        phase: 'lobby',
        createdAt: now,
        settings: { ...DEFAULT_SETTINGS },
        players: { [uid]: { name, online: true, joinedAt: now } },
      };
    }, { applyLocally: false });
    if (result.committed) return code;
  }
  throw new RoomError('방 코드를 만들지 못했어요. 다시 시도해 주세요.');
}

export async function joinRoom(code, uid, name) {
  const snap = await get(roomRef(code));
  const room = snap.val();
  if (!room) throw new RoomError('그런 방이 없어요. 코드를 확인해 주세요.');
  const players = room.players || {};
  const banned = room.banned || {};
  if (banned[uid] || (room.class && Object.values(banned).includes(name))) throw new RoomError('선생님이 이 모둠에서 내보냈어요. 선생님께 말씀드려 주세요.');
  if (players[uid]) {
    // 재접속: 같은 사람으로 복귀
    await update(roomRef(code, `players/${uid}`), { name, online: true });
    return;
  }
  const same = Object.values(players).find((p) => p.name === name);
  if (same) {
    // 수업 방: 기기나 브라우저가 바뀌어 다른 사람으로 인식된 학생이 원래 이름으로 자리를 되찾는다
    if (room.class && !same.online) return reclaimSeat(code, uid, name);
    throw new RoomError(room.class
      ? `'${name}' 이름으로 지금 접속 중인 학생이 있어요. 원래 쓰던 기기를 닫았다면 30초쯤 뒤에 다시 눌러 주세요.`
      : `'${name}' 이름을 쓰는 사람이 이미 있어요. 성을 붙이거나 다른 이름으로 들어와 주세요.`);
  }
  if (room.phase !== 'lobby') {
    throw new RoomError(room.class
      ? '게임이 진행 중인 모둠이에요. 원래 이 모둠에서 하던 학생이라면 그때 쓴 이름을 그대로 적어 주세요.'
      : '이미 게임이 진행 중인 방이에요.');
  }
  if (Object.keys(players).length >= MAX_PLAYERS) throw new RoomError(`방이 꽉 찼어요 (최대 ${MAX_PLAYERS}명).`);
  await set(roomRef(code, `players/${uid}`), { name, online: true, joinedAt: serverTimestamp() });
}

const RECLAIM_WAIT_MS = 10000;

/**
 * 자리 되찾기 요청: 선생님 화면이 이름이 같은 (연결 끊긴) 자리를 새 기기(uid)로 옮겨 준다.
 * 그린 페이지·스케치북 순서도 함께 옮겨지므로 하던 차례부터 이어서 한다.
 */
async function reclaimSeat(code, uid, name) {
  await set(roomRef(code, `rejoin/${uid}`), { name, at: serverTimestamp() });
  const moved = await new Promise((resolve) => {
    let done = false;
    let off = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (off) off();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), RECLAIM_WAIT_MS);
    off = onValue(roomRef(code, `players/${uid}`), (snap) => { if (snap.exists()) finish(true); }, () => finish(false));
    if (done) off();
  });
  if (moved) return;
  await remove(roomRef(code, `rejoin/${uid}`)).catch(() => {});
  throw new RoomError('자리를 되찾지 못했어요. 선생님 화면이 켜져 있는지 확인하고 다시 눌러 주세요.');
}

export async function leaveRoom(code, uid) {
  // 나가기가 서버에 반영된 뒤에 접속 상태 감시를 끈다.
  // (먼저 끄면, 반영 전에 탭이 닫힐 때 '접속 중'인 유령 참가자가 남는다)
  try {
    const snap = await get(roomRef(code, 'phase'));
    if (snap.val() === 'lobby') {
      await remove(roomRef(code, `players/${uid}`));
    } else {
      await set(roomRef(code, `players/${uid}/online`), false);
    }
  } finally {
    stopPresence();
  }
}

// ---- 접속 상태(onDisconnect) ----
let presenceOff = null;

export function startPresence(code, uid) {
  stopPresence();
  const playerRef = roomRef(code, `players/${uid}`);
  const onlineRef = roomRef(code, `players/${uid}/online`);
  const off = onValue(ref(db, '.info/connected'), async (snap) => {
    if (snap.val() !== true) return;
    try {
      // 끊긴 시각도 남긴다: 방장이 잠깐 끊긴 사람을 조금 기다려 줄 수 있게
      await onDisconnect(playerRef).update({ online: false, offAt: serverTimestamp() });
      // 플레이어가 아직 방에 있을 때만 online 복구 (보안 규칙이 name 없는 생성은 막음)
      await set(onlineRef, true);
    } catch (e) {
      console.warn('presence', e);
    }
  });
  presenceOff = () => { off(); onDisconnect(playerRef).cancel().catch(() => {}); };
}

export function stopPresence() {
  if (presenceOff) presenceOff();
  presenceOff = null;
}

// ---- 방장 전용 ----
export function updateSettings(code, settings) {
  return update(roomRef(code, 'settings'), settings);
}

/**
 * 방장이 오프라인이면, 남은 온라인 플레이어 중 joinedAt이 가장 빠른 사람이 방장을 넘겨받는다.
 * 모든 클라이언트가 같은 계산을 하므로 '나'가 대상일 때만 쓴다.
 */
export async function maybeClaimHost(code, room, uid) {
  if (room.class) return; // 수업 방은 선생님만 진행
  const players = room.players || {};
  const host = players[room.hostId];
  if (host && host.online) return;
  const candidates = Object.entries(players)
    .filter(([, p]) => p.online)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  if (!candidates.length || candidates[0][0] !== uid) return;
  const oldHost = room.hostId;
  await runTransaction(roomRef(code, 'hostId'), (cur) => (cur === oldHost ? uid : undefined))
    .catch((e) => console.warn('claim host', e));
}
