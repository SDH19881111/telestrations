// Firebase 초기화, 익명 로그인, DB 헬퍼
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator,
  setPersistence, browserSessionPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getDatabase, ref, onValue, get, set, update, remove, runTransaction,
  onDisconnect, serverTimestamp, connectDatabaseEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const params = new URLSearchParams(location.search);
// ?emulator=1 : 로컬 Firebase 에뮬레이터 사용 (개발/테스트용)
export const USE_EMULATOR = params.has('emulator');
// ?multi=1 : 탭마다 다른 익명 계정 (한 PC에서 여러 명 테스트할 때)
const PER_TAB = params.has('multi');

export const isConfigured = USE_EMULATOR || !firebaseConfig.apiKey.startsWith('YOUR_');

const config = USE_EMULATOR
  ? { apiKey: 'demo-key', projectId: 'demo-telestrations', databaseURL: 'http://127.0.0.1:9000?ns=demo-telestrations-default-rtdb' }
  : firebaseConfig;

const app = initializeApp(config);
export const auth = getAuth(app);
export const db = getDatabase(app);

if (USE_EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectDatabaseEmulator(db, '127.0.0.1', 9000);
}

export { ref, onValue, get, set, update, remove, runTransaction, onDisconnect, serverTimestamp };

// 서버 시각 보정값 — 타이머는 기기 시계가 아니라 이 값 기준으로 맞춘다
let serverOffset = 0;
onValue(ref(db, '.info/serverTimeOffset'), (snap) => { serverOffset = snap.val() || 0; });
export const serverNow = () => Date.now() + serverOffset;

export function roomRef(code, path = '') {
  return ref(db, `rooms/${code}${path ? '/' + path : ''}`);
}

/** 익명 로그인 후 uid 반환. 같은 브라우저면 새로고침해도 같은 uid. */
export async function ensureAuth() {
  if (PER_TAB) await setPersistence(auth, browserSessionPersistence);
  if (auth.currentUser) return auth.currentUser.uid;
  const existing = await new Promise((resolve) => {
    const off = onAuthStateChanged(auth, (user) => { off(); resolve(user); });
  });
  if (existing) return existing.uid;
  const cred = await signInAnonymously(auth);
  return cred.user.uid;
}
