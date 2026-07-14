/**
 * 방문자 카운터: 오늘 방문자 수 + 누적 방문자 수 (data/visits.json 영구 저장)
 * 방문자 id(브라우저 localStorage) 기준으로 하루에 한 번만 집계한다.
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('./security');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'visits.json');

// 하루에 추적하는 순 방문자 id 최대 개수 (메모리·디스크 무한 증가 방지)
const MAX_SEEN_TODAY = 50000;

/** 서버 로컬 기준 YYYY-MM-DD */
function localDate() {
  return new Date().toLocaleDateString('sv-SE');
}

class VisitStore {
  constructor() {
    this.data = { total: 0, today: 0, date: localDate(), seenToday: [] };
    try {
      const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      this.data = { ...this.data, ...loaded };
    } catch {
      /* 첫 실행 */
    }
    if (!Array.isArray(this.data.seenToday)) this.data.seenToday = [];
    this.seen = new Set(this.data.seenToday); // 빠른 중복 확인용
    this.dirty = false;
    this.rollover();
  }

  /** 날짜가 바뀌면 오늘 카운트 초기화 */
  rollover() {
    const today = localDate();
    if (this.data.date !== today) {
      this.data.date = today;
      this.data.today = 0;
      this.data.seenToday = [];
      this.seen = new Set();
      this.save(true);
    }
  }

  /** 방문 기록 — 같은 방문자는 하루 한 번만 집계 */
  visit(vid) {
    this.rollover();
    const id = String(vid || '').slice(0, 40);
    // 집합이 한도에 차면 새 id 는 카운트만 하고 추적하지 않는다(메모리 상한 유지)
    if (id && !this.seen.has(id)) {
      if (this.seen.size < MAX_SEEN_TODAY) {
        this.seen.add(id);
        this.data.seenToday.push(id);
      }
      this.data.today++;
      this.data.total++;
      this.save();
    }
    return { today: this.data.today, total: this.data.total };
  }

  /**
   * 디스크 저장을 최대 2초에 한 번으로 합쳐 이벤트 루프 부담과
   * 잦은 동기 쓰기를 막는다(immediate=true 면 즉시 저장).
   */
  save(immediate = false) {
    this.dirty = true;
    if (immediate) return this.flush();
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 2000);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      atomicWriteJSON(DATA_FILE, this.data);
    } catch (e) {
      console.error('방문자 수 저장 실패:', e.message);
    }
  }
}

module.exports = { VisitStore };
