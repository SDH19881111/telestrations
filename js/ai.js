// AI 설명 힌트 (Google AI Studio · Gemini API)
// 선생님 브라우저에서 바로 부른다. 키는 선생님 브라우저(localStorage)에만 두고, 보내는 것은 제시어 목록뿐이다.
// 모델은 자주 바뀌고 계정마다 쓸 수 있는 모델이 달라서, 비워 두면 그 키로 쓸 수 있는 가장 최신 Flash 모델을 고른다.
import { letters } from './hints.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** 예전 기본값. 새 키로는 쓸 수 없게 되어 저장돼 있으면 자동 선택으로 바꾼다. */
export const OLD_DEFAULT_MODELS = ['gemini-2.5-flash'];

const version = (name) => {
  const v = name.match(/gemini-(\d+(?:\.\d+)?)/);
  return v ? parseFloat(v[1]) : 0;
};

/**
 * 모델 목록(ListModels 응답의 models)을 설명 만들기에 알맞은 순서로 늘어놓는다.
 * 정식 Flash (lite·이미지·음성 등 특수 모델 제외, 버전 높은 순) → 미리보기 Flash → 나머지 Flash → 아무 Gemini.
 * 목록에 있어도 새 사용자에게는 막힌 모델(예: 2.5)이 있어서, 앞 모델이 404면 다음 모델을 쓴다.
 */
export function rankModels(models) {
  const usable = (models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => (m.name || '').replace(/^models\//, ''))
    .filter(Boolean);
  const special = /(lite|image|tts|audio|live|embed|vision|thinking|robotics|computer|native|search|learnlm|aqa|nano|banana)/i;
  const tiers = [
    usable.filter((n) => /flash/.test(n) && !special.test(n) && !/(preview|exp)/.test(n)),
    usable.filter((n) => /flash/.test(n) && !special.test(n)),
    usable.filter((n) => /flash/.test(n)),
    usable.filter((n) => /^gemini/.test(n) && !special.test(n)),
  ];
  const out = [];
  for (const t of tiers) {
    for (const n of t.sort((a, b) => version(b) - version(a) || a.length - b.length || a.localeCompare(b))) {
      if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}

export const chooseModel = (models) => rankModels(models)[0] || '';

/** 구글 서버가 붐빌 때(일시적): 잠깐 기다렸다 다시, 그래도 안 되면 다른 모델로 */
const isBusy = (status) => status === 500 || status === 502 || status === 503 || status === 504;
/** 다른 모델로 넘어가 볼 오류: 없는 모델, 모델별 사용량 초과, 서버 붐빔 */
const tryNext = (status) => status === 404 || status === 429 || isBusy(status);

function apiError(res, data, model) {
  const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
  const err = (text) => Object.assign(new Error(text), { status: res.status });
  if (res.status === 404) return err(`모델 '${model}'을 쓸 수 없어요. 모델 칸을 비우면 자동으로 골라요.`);
  if (res.status === 400 || res.status === 401 || res.status === 403) return err(`API 키를 확인해 주세요. (${msg})`);
  if (res.status === 429) return err('무료 사용량을 다 썼어요. 1~2분 뒤에 다시 눌러 주세요. (하루 사용량을 다 썼다면 내일 다시)');
  if (isBusy(res.status)) return err('구글 AI 서버가 지금 붐벼요. 1~2분 뒤에 다시 눌러 주세요.');
  return err(msg);
}

const ranked = new Map(); // 키별 후보 모델 목록 (한 번만 받는다)
const MAX_TRIES = 8;
let retryDelays = [2000, 5000]; // 붐빌 때 첫 모델을 다시 시도하기 전 기다리는 시간

/** 테스트용: 다시 시도 전 기다리는 시간 */
export function setRetryDelays(ms) { retryDelays = ms; }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function candidates(key) {
  if (ranked.has(key)) return ranked.get(key);
  const res = await fetch(`${BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data, '(목록)');
  const list = rankModels(data.models);
  if (!list.length) throw new Error('이 키로 쓸 수 있는 Gemini 모델이 없어요. AI Studio에서 키를 확인해 주세요.');
  ranked.set(key, list);
  return list;
}

export function aiPrompt(words, maxLen) {
  return [
    '초등학생이 하는 그림 맞히기 게임의 힌트를 만들어 주세요.',
    `각 단어를 초등학생이 알아듣는 쉬운 말로 ${maxLen}자 이내 한 문장으로 설명하세요.`,
    '설명에 그 단어 자체나 단어의 글자를 쓰지 마세요. 정답을 바로 알려 주지 말고 떠올릴 수 있게만 도와주세요.',
    '다른 말 없이 JSON 객체 하나로만 답하세요. 형식: {"단어": "설명"}',
    `단어: ${JSON.stringify(words)}`,
  ].join('\n');
}

async function generate(words, key, model, maxLen) {
  const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: aiPrompt(words, maxLen) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data, model);
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  const json = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
  return json && typeof json === 'object' ? json : {};
}

/**
 * 단어들의 설명을 받는다. model(비었으면 자동 후보 1순위)을 먼저 쓰고,
 * 서버가 붐비면 잠깐 기다렸다 다시, 그래도 안 되거나 쓸 수 없는 모델이면 다음 후보 모델로 넘어간다.
 * onNote(글): 기다리거나 모델을 바꿀 때 화면에 알릴 말.
 * → { got: {단어: 설명}, model: 실제로 쓴 모델 }
 */
export async function describeWords(words, key, model = '', maxLen = 25, onNote = () => {}) {
  let lastErr = null;
  let first = true;
  const attempt = async (m) => {
    try {
      return await generate(words, key, m, maxLen);
    } catch (e) {
      if (!first || !isBusy(e.status)) throw e;
      // 첫 모델만 조금 기다렸다 다시 (보통 금방 풀린다)
      for (const ms of retryDelays) {
        onNote(`구글 서버가 붐벼서 ${Math.round(ms / 1000)}초 기다렸다 다시 해 볼게요…`);
        await wait(ms);
        try { return await generate(words, key, m, maxLen); } catch (e2) { if (!isBusy(e2.status)) throw e2; e = e2; }
      }
      throw e;
    } finally {
      first = false;
    }
  };
  const tryModel = async (m) => {
    try {
      return { got: await attempt(m), model: m };
    } catch (e) {
      if (!tryNext(e.status)) throw e;
      lastErr = e;
      if (e.status === 404 && ranked.has(key)) ranked.set(key, ranked.get(key).filter((n) => n !== m)); // 막힌 모델은 다음부터 건너뛴다
      return null;
    }
  };
  if (model) {
    const r = await tryModel(model);
    if (r) return r;
  }
  for (const m of (await candidates(key)).filter((n) => n !== model).slice(0, MAX_TRIES)) {
    if (lastErr) onNote(`다른 모델(${m})로 해 볼게요…`);
    const r = await tryModel(m);
    if (r) return r;
  }
  throw lastErr || new Error('쓸 수 있는 Gemini 모델을 찾지 못했어요.');
}

/** 정답이 드러나는 설명은 버린다 (단어 전체나 두 글자 이상 이어진 부분이 들어 있으면) */
export function leaksAnswer(word, d) {
  const w = letters(word).join('');
  const t = letters(d).join('');
  if (t.includes(w)) return true;
  for (let i = 0; i + 2 <= w.length; i++) if (t.includes(w.slice(i, i + 2))) return true;
  return false;
}
