/**
 * 개선 요청 / 개발자에게 한마디 (data/feedback.json 영구 저장)
 * - 누구나 남길 수 있고(공개 제출), 열람은 관리자만 가능
 * - 최신순 보관, 총량 상한으로 무한 증가 방지
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('./security');

const DATA_FILE = path.join(__dirname, '..', 'data', 'feedback.json');
const MAX_ITEMS = 2000; // 보관 상한 (오래된 것부터 버림)
const MAX_MSG = 1000; // 메시지 길이 상한
const MAX_NAME = 20;

class FeedbackStore {
  constructor() {
    this.items = [];
    try {
      const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (Array.isArray(loaded)) this.items = loaded;
    } catch {
      /* 첫 실행 */
    }
  }

  /** 개선 요청 등록 → {ok} */
  add({ message, name } = {}) {
    const msg = String(message || '').trim().slice(0, MAX_MSG);
    if (!msg) return { ok: false, error: '내용을 입력해주세요.' };
    const who = String(name || '').trim().slice(0, MAX_NAME) || '익명';
    this.items.push({ message: msg, name: who, at: Date.now() });
    if (this.items.length > MAX_ITEMS) this.items = this.items.slice(-MAX_ITEMS);
    this.save();
    return { ok: true };
  }

  /** 관리자 열람용 — 최신순 */
  list() {
    return [...this.items].reverse();
  }

  save() {
    try {
      atomicWriteJSON(DATA_FILE, this.items);
    } catch (e) {
      console.error('개선 요청 저장 실패:', e.message);
    }
  }
}

module.exports = { FeedbackStore };
