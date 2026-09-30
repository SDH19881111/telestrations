// AI 설명 힌트: 모델 자동 선택·정답 노출 검사
import assert from 'node:assert/strict';
import { chooseModel, rankModels, leaksAnswer } from '../js/ai.js';

const m = (name, methods = ['generateContent']) => ({ name: `models/${name}`, supportedGenerationMethods: methods });

assert.equal(chooseModel([
  m('gemini-2.5-flash'), m('gemini-3.8-flash'), m('gemini-3.8-flash-lite'), m('gemini-3.9-flash-preview'),
  m('gemini-3.8-flash-image'), m('gemini-3.8-pro'), m('text-embedding-004', ['embedContent']), m('gemini-3.8-flash-001'),
]), 'gemini-3.8-flash', 'newest stable flash');
assert.deepEqual(rankModels([m('gemini-3.9-flash-preview'), m('gemini-2.5-flash'), m('gemini-3.5-flash-lite')]),
  ['gemini-2.5-flash', 'gemini-3.9-flash-preview', 'gemini-3.5-flash-lite'], 'stable → preview → lite (404 falls through)');
assert.equal(chooseModel([m('gemini-3.9-flash-preview')]), 'gemini-3.9-flash-preview', 'preview when no stable');
assert.equal(chooseModel([m('gemini-3.5-flash-lite')]), 'gemini-3.5-flash-lite', 'lite as last flash');
assert.equal(chooseModel([m('gemini-3.8-pro'), m('gemma-4', ['generateContent'])]), 'gemini-3.8-pro', 'any gemini');
assert.equal(chooseModel([m('gemini-3.8-flash', ['countTokens'])]), '', 'must support generateContent');
assert.equal(chooseModel(undefined), '');

assert.equal(leaksAnswer('달팽이', '등에 집을 지고 다녀요'), false);
assert.equal(leaksAnswer('달팽이', '달팽이는 느려요'), true);
assert.equal(leaksAnswer('무지개', '비 온 뒤 무지 예쁜 색'), true, 'two-letter fragment');
assert.equal(leaksAnswer('해', '낮에 뜨는 해님'), true);

console.log('ai tests passed');
