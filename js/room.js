// 방 만들기·입장·로비·접속 상태
import {
  db, ref, get, set, update, remove, runTransaction, onValue, onDisconnect,
  serverTimestamp, serverNow, roomRef,
} from './firebase.js';

export const MIN_PLAYERS = 4;
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
  if (!room || !room.players) throw new RoomError('그런 방이 없어요. 코드를 확인해 주세요.');
  const players = room.players;
  if (players[uid]) {
    // 재접속: 같은 사람으로 복귀
    await update(roomRef(code, `players/${uid}`), { name, online: true });
    return;
  }
  if (room.phase !== 'lobby') throw new RoomError('이미 게임이 진행 중인 방이에요.');
  if (Object.keys(players).length >= MAX_PLAYERS) throw new RoomError(`방이 꽉 찼어요 (최대 ${MAX_PLAYERS}명).`);
  await set(roomRef(code, `players/${uid}`), { name, online: true, joinedAt: serverTimestamp() });
}

export async function leaveRoom(code, uid) {
  stopPresence();
  const snap = await get(roomRef(code, 'phase'));
  if (snap.val() === 'lobby') {
    await remove(roomRef(code, `players/${uid}`));
  } else {
    await set(roomRef(code, `players/${uid}/online`), false);
  }
}

// ---- 접속 상태(onDisconnect) ----
let presenceOff = null;

export function startPresence(code, uid) {
  stopPresence();
  const onlineRef = roomRef(code, `players/${uid}/online`);
  const off = onValue(ref(db, '.info/connected'), async (snap) => {
    if (snap.val() !== true) return;
    try {
      await onDisconnect(onlineRef).set(false);
      // 플레이어가 아직 방에 있을 때만 online 복구 (보안 규칙이 name 없는 생성은 막음)
      await set(onlineRef, true);
    } catch (e) {
      console.warn('presence', e);
    }
  });
  presenceOff = () => { off(); onDisconnect(onlineRef).cancel().catch(() => {}); };
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
