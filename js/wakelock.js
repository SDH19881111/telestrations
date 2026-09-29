// 게임 중 화면 꺼짐 방지 (Screen Wake Lock API)
// 태블릿 화면이 꺼지면 연결이 끊겨 차례가 건너뛰어지므로, 방에 있는 동안 화면을 켜 둔다.
// 탭이 가려지면 브라우저가 잠금을 풀기 때문에 다시 보일 때 새로 요청한다. 지원하지 않는 브라우저는 그냥 넘어간다.
let wanted = false;
let lock = null;
let requesting = false;

async function acquire() {
  if (!wanted || lock || requesting || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  requesting = true;
  try {
    const l = await navigator.wakeLock.request('screen');
    l.addEventListener('release', () => { if (lock === l) lock = null; });
    if (wanted) lock = l; else l.release().catch(() => {}); // 기다리는 사이 방을 나갔으면 바로 푼다
  } catch { /* 배터리 절약 모드 등으로 거부되면 무시 */ }
  requesting = false;
}

document.addEventListener('visibilitychange', acquire);
document.addEventListener('pointerdown', acquire); // 터치 뒤에만 허용하는 브라우저 대비

export function keepScreenOn(on) {
  wanted = on;
  if (on) acquire();
  else if (lock) { lock.release().catch(() => {}); lock = null; }
}
