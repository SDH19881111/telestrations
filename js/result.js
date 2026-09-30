// 결과 화면: 스케치북을 한 권씩, 한 장씩 넘겨 보기 (방장이 넘기면 모두 같이 넘어가는 발표 모드)
import { setResultView } from './game.js';

const $ = (sel) => document.querySelector(sel);

/** 스케치북 한 권의 페이지 목록 (짝수 인원은 별도 저장된 제시어를 첫 줄로) */
export function bookEntries(room, b) {
  const book = (room.books && room.books[b]) || {};
  const N = room.order.length;
  const pages = [];
  if (N % 2 === 0) pages.push({ type: 'word', by: book.owner, content: book.word || '(건너뜀)' });
  for (let r = 0; r < N; r++) {
    const p = book.pages && book.pages[r];
    pages.push(p || { type: 'guess', content: '', skipped: true });
  }
  return pages;
}

function nameOf(room, uid) {
  const p = room.players && room.players[uid];
  return p ? p.name : '(나간 사람)';
}

function entryEl(room, e, idx) {
  const div = document.createElement('div');
  div.className = `entry entry-${e.type}`;
  const who = document.createElement('div');
  who.className = 'entry-who';
  const label = { word: '제시어', draw: '그림', guess: '추측' }[e.type] || '';
  who.textContent = `${idx + 1}. ${nameOf(room, e.by)} · ${label}`;
  div.appendChild(who);

  if (e.skipped || !e.content) {
    const t = document.createElement('div');
    t.className = 'entry-text muted';
    t.textContent = e.hidden ? '(선생님이 가렸어요)' : e.skipped ? '(건너뜀)' : '(빈 답)';
    div.appendChild(t);
  } else if (e.type === 'draw') {
    const img = document.createElement('img');
    img.src = e.content;
    img.alt = `${nameOf(room, e.by)}의 그림`;
    div.appendChild(img);
  } else {
    const t = document.createElement('div');
    t.className = 'entry-text';
    t.textContent = e.content;
    div.appendChild(t);
  }
  return div;
}

let freeView = null; // 자유 보기 모드일 때의 로컬 위치
let lastRendered = '';

export function resetResult() {
  freeView = null;
  lastRendered = '';
}

/** 혼자 넘겨 보기로 시작 (학생 화면: 결과를 각자 자유롭게 보고 '준비 완료'를 누른다) */
export function startFreeView(v) {
  freeView = v;
  lastRendered = '';
}

function clampView(room, v) {
  const N = room.order.length;
  const book = Math.min(Math.max(v.book, 0), N - 1);
  const max = bookEntries(room, book).length - 1;
  return { book, step: Math.min(Math.max(v.step, 0), max) };
}

function nextView(room, v) {
  const max = bookEntries(room, v.book).length - 1;
  if (v.step < max) return { book: v.book, step: v.step + 1 };
  if (v.book < room.order.length - 1) return { book: v.book + 1, step: 0 };
  return v;
}

function prevView(room, v) {
  if (v.step > 0) return { book: v.book, step: v.step - 1 };
  if (v.book > 0) return { book: v.book - 1, step: bookEntries(room, v.book - 1).length - 1 };
  return v;
}

export function renderResult(ctx) {
  const { room, uid, code } = ctx;
  const isHost = room.hostId === uid;
  const shared = clampView(room, room.resultView || { book: 0, step: 0 });
  const view = freeView ? clampView(room, freeView) : shared;
  const N = room.order.length;

  // 탭 (스케치북 목록)
  const tabs = $('#result-tabs');
  const tabKey = room.order.map((u) => nameOf(room, u)).join('|') + view.book;
  if (tabs.dataset.key !== tabKey) {
    tabs.dataset.key = tabKey;
    tabs.innerHTML = '';
    room.order.forEach((owner, b) => {
      const btn = document.createElement('button');
      btn.className = 'tab' + (b === view.book ? ' active' : '');
      btn.textContent = nameOf(room, owner);
      btn.addEventListener('click', () => go({ book: b, step: freeView ? bookEntries(room, b).length - 1 : 0 }));
      tabs.appendChild(btn);
    });
  }

  const entries = bookEntries(room, view.book);
  $('#result-title').textContent = `${nameOf(room, room.order[view.book])}의 스케치북 (${view.book + 1}/${N})`;

  const key = `${view.book}:${view.step}:${freeView ? 'f' : 's'}:${entries.map((e) => (e.content || '').length + (e.hidden ? 'h' : '')).join()}`;
  if (key !== lastRendered) {
    const list = $('#result-pages');
    // 같은 스케치북에서 한 장 넘길 때만 새 장에 등장 애니메이션
    const prevCount = lastRendered.startsWith(`${view.book}:`) ? list.children.length : (view.step === 0 ? 0 : Infinity);
    list.innerHTML = '';
    for (let i = 0; i <= view.step; i++) {
      const el = entryEl(room, entries[i], i);
      if (i >= prevCount) el.classList.add('reveal');
      list.appendChild(el);
    }
    if (view.step >= prevCount) list.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    lastRendered = key;
  }

  const canControl = isHost || freeView;
  const atEnd = view.book === N - 1 && view.step === entries.length - 1;
  $('#result-prev').hidden = !canControl;
  $('#result-next').hidden = !canControl;
  $('#result-prev').disabled = view.book === 0 && view.step === 0;
  $('#result-next').disabled = atEnd;
  $('#result-next').textContent = view.step < entries.length - 1 ? '다음 장 ▶' : '다음 스케치북 ▶';
  $('#result-follow').hidden = isHost;
  $('#result-follow').textContent = freeView ? '📺 발표 따라가기' : '👀 혼자 넘겨 보기';
  const leader = room.class ? '선생님' : '방장';
  $('#result-hint').textContent = isHost
    ? `${leader}이 넘기면 모두의 화면이 같이 넘어가요.`
    : freeView ? '혼자 보는 중이에요.' : `${leader}이 넘기는 대로 보고 있어요.`;
  $('#result-lobby').hidden = !isHost;

  function go(v) {
    const next = clampView(room, v);
    if (isHost && !freeView) setResultView(code, next);
    else { freeView = next; renderResult(ctx); } // 방장이 아니면 누르는 순간 혼자 보기로 전환
  }

  // 버튼 핸들러는 매번 최신 ctx를 쓰도록 교체
  $('#result-prev').onclick = () => go(prevView(room, view));
  $('#result-next').onclick = () => go(nextView(room, view));
  $('#result-follow').onclick = () => {
    freeView = freeView ? null : { ...shared };
    lastRendered = '';
    renderResult(ctx);
  };
}
