/**
 * 전체 순위(리더보드) 저장소 (data/stats.json 영구 저장)
 *
 * 게임이 끝날 때마다 닉네임 기준으로 전적을 누적한다.
 * - 2인 이상 게임만 집계 (혼자 플레이로 승수 쌓기 방지)
 * - 점수: 참가자 수 - 순위 + 1 (4인 게임 1등 = 4점, 꼴찌 = 1점)
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'stats.json');

const MAX_LIST = 100;

class StatsStore {
  constructor() {
    this.byName = {}; // name -> { plays, wins, podiums, points }
    this.load();
  }

  load() {
    try {
      this.byName = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
      this.byName = {};
    }
  }

  persist() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(this.byName, null, 2));
  }

  /** 게임 종료 시 순위표를 전적에 반영 */
  record(ranking) {
    if (!Array.isArray(ranking) || ranking.length < 2) return; // 2인 이상만 집계
    const n = ranking.length;
    for (const r of ranking) {
      if (!r.name || r.name === '(나감)') continue;
      const s = this.byName[r.name] || { plays: 0, wins: 0, podiums: 0, points: 0 };
      s.plays += 1;
      if (r.rank === 1) s.wins += 1;
      if (r.rank <= 3) s.podiums += 1;
      s.points += n - r.rank + 1;
      this.byName[r.name] = s;
    }
    this.persist();
  }

  /** 점수순 전체 순위 */
  list() {
    return Object.entries(this.byName)
      .map(([name, s]) => ({ name, ...s }))
      .sort((a, b) => b.points - a.points || b.wins - a.wins || a.plays - b.plays)
      .slice(0, MAX_LIST)
      .map((entry, i) => ({ rank: i + 1, ...entry }));
  }
}

module.exports = { StatsStore };
