/**
 * 전체 순위(리더보드) 저장소 (data/stats.json 영구 저장)
 *
 * 게임이 끝날 때마다 닉네임 기준으로 전적을 누적한다.
 * - 2인 이상 게임만 집계 (혼자 플레이로 승수 쌓기 방지)
 * - 점수: 참가자 수 - 순위 + 1 (4인 게임 1등 = 4점, 꼴찌 = 1점)
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('./security');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'stats.json');

const MAX_LIST = 100;
// 저장 항목 상한 — 닉네임은 무한히 생기므로(임의 입력) 상위 점수만 남기고 정리.
// 리더보드(MAX_LIST)보다 넉넉히 잡아 잠깐 밀렸다 복귀하는 상위권을 보존.
const MAX_ENTRIES = 5000;

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
    this.evict(); // 예전에 상한 없이 쌓인 파일도 로드 시 정리
  }

  /** 항목이 상한을 넘으면 하위 점수부터 잘라내 메모리·디스크 무한 증가 방지 */
  evict() {
    const keys = Object.keys(this.byName);
    if (keys.length <= MAX_ENTRIES) return;
    const kept = keys
      .sort((a, b) => {
        const sa = this.byName[a];
        const sb = this.byName[b];
        return sb.points - sa.points || sb.wins - sa.wins || sb.plays - sa.plays;
      })
      .slice(0, MAX_ENTRIES);
    const next = {};
    for (const k of kept) next[k] = this.byName[k];
    this.byName = next;
  }

  persist() {
    this.evict();
    atomicWriteJSON(DATA_FILE, this.byName);
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
