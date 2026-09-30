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

function apiError(res, data, model) {
  const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
  if (res.status === 404) return Object.assign(new Error(`모델 '${model}'을 쓸 수 없어요. 모델 칸을 비우면 자동으로 골라요.`), { status: 404 });
  if (res.status === 400 || res.status === 401 || res.status === 403) return new Error(`API 키를 확인해 주세요. (${msg})`);
  if (res.status === 429) return new Error('무료 사용량을 다 썼어요. 잠시 뒤에 다시 해 주세요.');
  return new Error(msg);
}

const ranked = new Map(); // 키별 후보 모델 목록 (한 번만 받는다)
const MAX_TRIES = 5;

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
 * 단어들의 설명을 받는다. model을 먼저 쓰고, 비었거나 쓸 수 없으면(404) 자동 후보를 차례로 쓴다.
 * → { got: {단어: 설명}, model: 실제로 쓴 모델 }
 */
export async function describeWords(words, key, model = '', maxLen = 25) {
  let lastErr = null;
  if (model) {
    try {
      return { got: await generate(words, key, model, maxLen), model };
    } catch (e) {
      if (e.status !== 404) throw e;
      lastErr = e;
    }
  }
  for (const m of (await candidates(key)).filter((n) => n !== model).slice(0, MAX_TRIES)) {
    try {
      return { got: await generate(words, key, m, maxLen), model: m };
    } catch (e) {
      if (e.status !== 404) throw e;
      lastErr = e;
      ranked.set(key, ranked.get(key).filter((n) => n !== m)); // 막힌 모델은 다음부터 건너뛴다
    }
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
