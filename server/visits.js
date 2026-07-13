/**
 * 방문자 카운터: 오늘 방문자 수 + 누적 방문자 수 (data/visits.json 영구 저장)
 * 방문자 id(브라우저 localStorage) 기준으로 하루에 한 번만 집계한다.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'visits.json');

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
    this.rollover();
  }

  /** 날짜가 바뀌면 오늘 카운트 초기화 */
  rollover() {
    const today = localDate();
    if (this.data.date !== today) {
      this.data.date = today;
      this.data.today = 0;
      this.data.seenToday = [];
      this.save();
    }
  }

  /** 방문 기록 — 같은 방문자는 하루 한 번만 집계 */
  visit(vid) {
    this.rollover();
    const id = String(vid || '').slice(0, 40);
    if (id && !this.data.seenToday.includes(id)) {
      this.data.seenToday.push(id);
      this.data.today++;
      this.data.total++;
      this.save();
    }
    return { today: this.data.today, total: this.data.total };
  }

  save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(this.data));
    } catch (e) {
      console.error('방문자 수 저장 실패:', e.message);
    }
  }
}

module.exports = { VisitStore };
