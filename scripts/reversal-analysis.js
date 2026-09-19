/**
 * 맵별 '막판에 순위가 얼마나 뒤집히는가' 분석 (반전 맵 설계용 조사 도구)
 *
 * 실제 Game 클래스를 헤드리스로 돌린다(spread-analysis.js 와 같은 방식).
 * 선두 공이 골인선 D px 위를 처음 지나는 순간의 순위(체크포인트)와 최종 도착 순위를
 * 비교한다. 이 게임의 긴장은 "누가 꼴찌(커피값)냐"에 있으므로 꼴찌 유지율이 핵심 지표다.
 *
 *  - 선두 유지 : 체크포인트 1등이 최종 1등으로 끝난 비율
 *  - 꼴찌 유지 : 체크포인트 꼴찌가 최종 꼴찌로 끝난 비율 (낮을수록 반전이 잘 일어난다)
 *  - 하위2 유지: 체크포인트 하위 2명이 최종 하위 2명과 같은 비율 (커피값 2명 모드)
 *  - 순위 변동 : 체크포인트 순위와 최종 순위 사이에서 뒤집힌 쌍의 비율 (0=그대로, 1=완전 역순)
 *
 * 예: SIM_TIME_SCALE=1 node scripts/reversal-analysis.js 50 2 classic,minefield
 *     (판 수, 인당 공 수, 맵 id 목록 — 모두 생략 가능)
 */
const { Game } = require('../server/game');
const { MapStore } = require('../server/maps');
const settings = require('../server/settings');

if (process.env.SIM_TIME_SCALE) settings.data.timeScale = Number(process.env.SIM_TIME_SCALE);

const TRIALS = Number(process.argv[2] || 30);
const BALLS_PER = Number(process.argv[3] || 2);
const PLAYERS = 4;
const MAX_TICKS = 12000;
// 체크포인트: 선두가 골인선에서 이만큼 위를 지나는 순간 (먼 것 → 가까운 것)
const CHECKPOINTS = [1500, 700];

const io = { to: () => ({ emit: () => {} }) };
const COLORS = ['#b23a48', '#d4b06a', '#e9e4d6', '#2f8f6b'];

/** 현재 순위: 도착한 공은 도착 순서대로 앞에, 나머지는 y 가 큰(골인에 가까운) 순 */
function ranking(g, finishOrder) {
  const rest = [...g.balls]
    .filter(([k, b]) => !b.plugin.done)
    .sort((a, b) => b[1].position.y - a[1].position.y)
    .map(([k]) => k);
  return [...finishOrder, ...rest];
}

/** 두 순위 사이에서 순서가 뒤집힌 쌍의 비율 (켄달 거리 정규화) */
function swapFrac(a, b) {
  const pos = new Map(b.map((k, i) => [k, i]));
  let swapped = 0, pairs = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = i + 1; j < a.length; j++) {
      pairs++;
      if (pos.get(a[i]) > pos.get(a[j])) swapped++;
    }
  return pairs ? swapped / pairs : 0;
}

function runOnce(mapDef) {
  const players = new Map();
  for (let i = 0; i < PLAYERS; i++) players.set('p' + i, { id: 'p' + i, name: 'P' + i, color: COLORS[i] });
  const room = {
    code: 'SIM', players, spectators: new Map(), series: null,
    itemsEnabled: false, ballsPerPlayer: BALLS_PER, winMode: 'first', payers: 1,
  };
  const g = new Game(room, io, mapDef, () => {});
  g.start();
  clearInterval(g.interval);
  g.interval = null;
  g.drop();

  const finishOrder = [];
  const snaps = new Map(); // D -> 순위 스냅샷
  let tick = 0;
  for (; tick < MAX_TICKS && !g.over; tick++) {
    g.tick();
    for (const [k, b] of g.balls) if (b.plugin.done && !finishOrder.includes(k)) finishOrder.push(k);
    let lead = -Infinity;
    for (const b of g.balls.values()) if (!b.plugin.done) lead = Math.max(lead, b.position.y);
    for (const D of CHECKPOINTS) {
      if (!snaps.has(D) && (finishOrder.length > 0 || lead >= g.goalY - D)) snaps.set(D, ranking(g, finishOrder));
    }
  }
  const final = ranking(g, finishOrder);
  const n = final.length;
  const out = { dur: tick / 60, timedOut: finishOrder.length < n, cp: {} };
  for (const D of CHECKPOINTS) {
    const s = snaps.get(D) || final;
    out.cp[D] = {
      leaderHolds: s[0] === final[0],
      lastHolds: s[n - 1] === final[n - 1],
      bottom2Holds: new Set(s.slice(-2)).size === 2 && s.slice(-2).every((k) => final.slice(-2).includes(k)),
      swap: swapFrac(s, final),
    };
  }
  return out;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (v) => `${Math.round(v * 100)}%`.padStart(5);

(function main() {
  const store = new MapStore();
  const only = (process.argv[4] || '').split(',').filter(Boolean);
  const maps = store.list().filter((m) => m.builtin && (!only.length || only.includes(m.id)));
  console.log(`${PLAYERS}명 × 공 ${BALLS_PER}개 · 맵당 ${TRIALS}판 · 낙하 배속 ${settings.get('timeScale')}×`);
  console.log('체크포인트 = 선두가 골인선 D px 위를 지나는 순간. 꼴찌 유지가 낮을수록 막판 반전이 잦다.\n');
  const head = '맵'.padEnd(20) + '낙하(중앙)  타임아웃 │';
  const sub = CHECKPOINTS.map((D) => ` D=${String(D).padStart(4)}: 선두유지 꼴찌유지 하위2유지 순위변동 │`).join('');
  console.log(head + sub);
  console.log('─'.repeat(head.length + sub.length));
  for (const meta of maps) {
    const rs = [];
    for (let i = 0; i < TRIALS; i++) rs.push(runOnce(store.get(meta.id)));
    let line = meta.name.padEnd(20 - Math.max(0, [...meta.name].filter((c) => c.charCodeAt(0) > 255).length - 1))
      + `${median(rs.map((r) => r.dur)).toFixed(1)}초`.padStart(9) + `${rs.filter((r) => r.timedOut).length}`.padStart(9) + ' │';
    for (const D of CHECKPOINTS) {
      const c = rs.map((r) => r.cp[D]);
      line += `          ${pct(mean(c.map((x) => x.leaderHolds ? 1 : 0)))}   ${pct(mean(c.map((x) => x.lastHolds ? 1 : 0)))}    ${pct(mean(c.map((x) => x.bottom2Holds ? 1 : 0)))}    ${pct(mean(c.map((x) => x.swap)))} │`;
    }
    console.log(line);
  }
})();
