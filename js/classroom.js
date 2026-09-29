// 수업(교사) 모드: 수업 코드·비밀번호, 모둠 방 열기/닫기, 학생 강퇴
import { ref, db, get, set, update, remove, serverNow, roomRef } from './firebase.js';
import { DEFAULT_SETTINGS, classRoomId, RoomError } from './room.js';

export const MAX_GROUPS = 8;
export const DEFAULT_CLASS = { groups: 2, open: false, leaderStart: true, settings: { ...DEFAULT_SETTINGS }, words: [] };

const classRef = (code, path = '') => ref(db, `classes/${code}${path ? '/' + path : ''}`);

/** 비밀번호는 저장하지 않고 '수업코드:비밀번호'의 SHA-256만 비교한다 (보안 규칙이 서버에서 비교) */
export async function hashPassword(code, password) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${code}:${password}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getClass(code) {
  const snap = await get(classRef(code));
  return snap.val();
}

/** 이 브라우저(익명 uid)가 이미 이 수업의 선생님으로 로그인했는지 */
export async function isOwner(code, uid) {
  try {
    return (await get(ref(db, `ownerClaims/${code}/${uid}`))).exists();
  } catch {
    return false;
  }
}

/** 기존 수업에 로그인. 비밀번호가 다르면 보안 규칙이 거부한다.
 *  저장소(data/classes.json)로 먼저 만들어진 수업은 비밀번호가 없으므로, 처음 들어온 선생님의 비밀번호로 정해진다. */
export async function loginClass(code, password, uid) {
  const hash = await hashPassword(code, password);
  try {
    await set(ref(db, `classSecrets/${code}`), hash);
  } catch {
    // 이미 비밀번호가 있는 수업 — 아래에서 비교한다
  }
  try {
    await set(ref(db, `ownerClaims/${code}/${uid}`), hash);
  } catch {
    throw new RoomError('비밀번호가 맞지 않아요.');
  }
}

/** 새 수업 만들기: 코드 선점 → 내 로그인 → 기본 설정 저장 */
export async function createClass(code, password, uid) {
  const hash = await hashPassword(code, password);
  try {
    await set(ref(db, `classSecrets/${code}`), hash);
  } catch {
    throw new RoomError('이미 다른 선생님이 쓰는 수업 코드예요. 다른 코드를 정해 주세요.');
  }
  await set(ref(db, `ownerClaims/${code}/${uid}`), hash);
  await set(classRef(code), { ...DEFAULT_CLASS, createdAt: serverNow() });
}

export function saveClass(code, data) {
  return update(classRef(code), data);
}

/** 모둠 방을 새로 연다 (이전 수업의 방과 참가자는 초기화). 선생님이 각 방의 진행자(host)가 된다. */
export async function openRooms(code, cls, uid) {
  const now = serverNow();
  for (let n = 1; n <= cls.groups; n++) {
    await set(roomRef(classRoomId(code, n)), {
      hostId: uid,
      class: code,
      group: n,
      phase: 'lobby',
      createdAt: now,
      settings: { ...cls.settings },
    });
  }
  // 모둠 수를 줄였다면 남는 방 정리
  for (let n = cls.groups + 1; n <= MAX_GROUPS; n++) {
    const id = classRoomId(code, n);
    if ((await get(roomRef(id, 'class'))).exists()) await remove(roomRef(id));
  }
  await update(classRef(code), { open: true, openedAt: now });
}

export async function closeRooms(code) {
  await update(classRef(code), { open: false });
  for (let n = 1; n <= MAX_GROUPS; n++) {
    const id = classRoomId(code, n);
    if ((await get(roomRef(id, 'class'))).exists()) await remove(roomRef(id));
  }
}

/** 선생님 화면에서 수업 방 진행권을 다시 가져온다 (다른 기기에서 로그인한 경우) */
export function claimRoomHost(roomId, uid) {
  return set(roomRef(roomId, 'hostId'), uid);
}

/** 모둠장의 시작 요청을 지운다 (인원이 모자라 시작할 수 없을 때) */
export function clearStartRequest(roomId) {
  return remove(roomRef(roomId, 'startRequest'));
}

export function kickPlayer(roomId, uid) {
  return remove(roomRef(roomId, `players/${uid}`));
}

/** 학생 화면: 모둠별 인원·상태. mine: 내가 이미 그 모둠의 참가자인지 (튕겼다가 돌아온 경우) */
export async function groupInfo(code, groups, uid) {
  const list = [];
  for (let n = 1; n <= groups; n++) {
    const room = (await get(roomRef(classRoomId(code, n)))).val();
    list.push({
      n,
      exists: !!room,
      count: room && room.players ? Object.keys(room.players).length : 0,
      phase: room ? room.phase : null,
      mine: !!(room && room.players && room.players[uid]),
    });
  }
  return list;
}
