/**
 * 맵별 '공이 얼마나 벌어지는가' 분석 (일회성 조사 도구)
 *
 * 실제 Game 클래스를 헤드리스로 돌린다 — 스폰 위치·물리·배속·아이템 획득까지
 * 라이브와 같은 경로를 타므로, 눈으로 보는 판과 같은 수치가 나온다.
 *
 * 핵심 지표
 *  - 화면 동시 표시율: 카메라가 선두를 쫓을 때 화면(900px) 안에 들어오는 공의 비율.
 *    이게 낮을수록 "누가 어디 있는지 모르겠다" = 긴장감이 죽는다.
 *  - 선두-꼴찌 간격(px): 남은 공들이 세로로 얼마나 흩어져 있나.
 *  - 골인 시간차: 1등과 꼴찌 사이 / 마지막 두 명 사이(= 커피값이 갈리는 순간).
 */
const { Game } = require('../server/game');
const { MapStore } = require('../server/maps');

const VIEW_H = 900; // 클라이언트 화면 높이 (public/client.js 의 VIEW.height)
const TRIALS = Number(process.argv[2] || 20);
const PLAYERS = 4;
const BALLS_PER = Number(process.argv[3] || 2);
const MAX_TICKS = 8000;

const io = { to: () => ({ emit: () => {} }) };
const COLORS = ['#b23a48', '#d4b06a', '#e9e4d6', '#2f8f6b'];

function runOnce(mapDef) {
  const players = new Map();
  for (let i = 0; i < PLAYERS; i++) {
    players.set('p' + i, { id: 'p' + i, name: 'P' + i, color: COLORS[i] });
  }
  const room = {
    code: 'SIM', players, spectators: new Map(), series: null,
    itemsEnabled: false, ballsPerPlayer: BALLS_PER, winMode: 'first', payers: 1,
  };
  const mapH = Number(mapDef.height) || 4800;
  const g = new Game(room, io, mapDef, () => {});
  g.start();
  clearInterval(g.interval);
  g.interval = null;
  g.drop(); // 셔플은 건너뛴다 (start() 가 이미 시작 패턴으로 공을 배치해 둔다)

  const finishTicks = [];
  let seenDone = 0;
  const spreads = [];
  const visFracs = [];
  // 🔁 되돌림: 깔때기를 놓쳐 맵 바닥으로 떨어진 공은 최상단으로 되돌아간다(board.js wrapIfFallen).
  //    한 번 걸리면 그 공은 순식간에 맵 길이만큼 뒤처진다 — 격차의 가장 큰 원인일 수 있다.
  let wraps = 0;
  const prevY = new Map();
  for (const [k, b] of g.balls) prevY.set(k, b.position.y);
  let tick = 0;
  for (; tick < MAX_TICKS && !g.over; tick++) {
    g.tick();
    for (const [k, b] of g.balls) {
      if (b.plugin.done) continue;
      const py = prevY.get(k);
      // 맵 아래쪽에 있다가 위로 크게 튄 경우만 되돌림 (포탈 순간이동과 구분한다)
      if (py !== undefined && py > mapH - 900 && py - b.position.y > 400) wraps++;
      prevY.set(k, b.position.y);
    }
    // 골인 시각은 매 틱 확인 (표본 주기와 어긋나면 마지막 골인을 놓친다)
    let done = 0;
    for (const b of g.balls.values()) if (b.plugin.done) done++;
    for (; seenDone < done; seenDone++) finishTicks.push(tick);
    if (tick % 3) continue; // 간격 표본은 3틱마다 (20Hz)
    const ys = [];
    for (const b of g.balls.values()) if (!b.plugin.done) ys.push(b.position.y);
    if (ys.length >= 2) {
      const lead = Math.max(...ys);
      const trail = Math.min(...ys);
      spreads.push(lead - trail);
      visFracs.push(ys.filter((y) => lead - y < VIEW_H).length / ys.length);
    }
  }
  const sec = (t) => t / 60; // 낙하 틱은 실시간 60Hz
  const total = g.balls.size;
  const arrived = finishTicks.length;
  const all = arrived === total;
  return {
    // 제한시간(180초)에 걸려 끝났다 = 못 들어온 공이 남았다 → 벌어짐이 심하다는 신호
    timedOut: !all,
    stranded: total - arrived,
    wraps,
    dur: sec(tick),
    meanSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 0,
    maxSpread: spreads.length ? Math.max(...spreads) : 0,
    // 화면 안에 다 담긴 표본 비율 / 평균 표시 비율
    allVisible: visFracs.length ? visFracs.filter((v) => v > 0.999).length / visFracs.length : 1,
    meanVisible: visFracs.length ? visFracs.reduce((a, b) => a + b, 0) / visFracs.length : 1,
    firstLast: all ? sec(finishTicks[arrived - 1] - finishTicks[0]) : null,
    lastTwo: all ? sec(finishTicks[arrived - 1] - finishTicks[arrived - 2]) : null,
  };
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s2 = [...a].sort((x, y) => x - y);
  const m = s2.length >> 1;
  return s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2;
};

(function main() {
  const store = new MapStore();
  const only = (process.argv[4] || '').split(',').filter(Boolean); // 특정 맵만 (쉼표 구분)
  const maps = store
    .list()
    .filter((m) => m.builtin && (!only.length || only.includes(m.id)));
  console.log(`${PLAYERS}명 × 공 ${BALLS_PER}개 (공 ${PLAYERS * BALLS_PER}개) · 맵당 ${TRIALS}판\n`);
  console.log('맵'.padEnd(24) + '판길이(중앙)  20초초과  평균간격  전원표시  1등~꼴찌  막판2명  되돌림');
  console.log('─'.repeat(96));
  const rows = [];
  for (const meta of maps) {
    const mapDef = store.get(meta.id);
    const rs = [];
    for (let i = 0; i < TRIALS; i++) rs.push(runOnce(mapDef));
    const ok = rs.filter((r) => !r.timedOut);
    const row = {
      id: meta.id,
      name: meta.name,
      dur: median(rs.map((r) => r.dur)),
      long: rs.filter((r) => r.dur > 20).length / rs.length,
      meanSpread: mean(rs.map((r) => r.meanSpread)),
      maxSpread: mean(rs.map((r) => r.maxSpread)),
      allVisible: mean(rs.map((r) => r.allVisible)),
      meanVisible: mean(rs.map((r) => r.meanVisible)),
      firstLast: mean(ok.map((r) => r.firstLast)),
      lastTwo: mean(ok.map((r) => r.lastTwo)),
      stuck: rs.filter((r) => r.timedOut).length,
      stranded: mean(rs.map((r) => r.stranded)),
      wraps: mean(rs.map((r) => r.wraps)),
    };
    rows.push(row);
    console.log(
      row.name.padEnd(22) +
        String(row.dur.toFixed(1)).padStart(6) + '초' +
        String((row.long * 100).toFixed(0) + '%').padStart(9) +
        String(Math.round(row.meanSpread)).padStart(10) +
        String((row.allVisible * 100).toFixed(0) + '%').padStart(9) +
        String(row.firstLast.toFixed(1) + '초').padStart(9) +
        String(row.lastTwo.toFixed(2) + '초').padStart(9) +
        String(row.wraps.toFixed(1)).padStart(8)
    );
  }
  console.log('\n── 전원이 한 화면에 담기는 비율이 낮은 순 (벌어짐이 심한 맵) ──');
  for (const r of [...rows].sort((a, b) => a.allVisible - b.allVisible).slice(0, 8)) {
    console.log(
      `  ${r.name.padEnd(22)} 전원표시 ${(r.allVisible * 100).toFixed(0)}% · 평균간격 ${Math.round(r.meanSpread)}px · 되돌림 ${r.wraps.toFixed(1)}회 · 1등~꼴찌 ${r.firstLast.toFixed(1)}초`
    );
  }
  // 되돌림 횟수와 벌어짐의 관계 (상관계수) — 되돌림이 주범인지 확인
  const xs = rows.map((r) => r.wraps);
  const ys2 = rows.map((r) => r.meanSpread);
  const mx = mean(xs), my = mean(ys2);
  const cov = mean(xs.map((x, i) => (x - mx) * (ys2[i] - my)));
  const sx = Math.sqrt(mean(xs.map((x) => (x - mx) ** 2)));
  const sy = Math.sqrt(mean(ys2.map((y) => (y - my) ** 2)));
  console.log(`\n되돌림 횟수 ↔ 평균간격 상관계수: ${(cov / (sx * sy)).toFixed(2)}  (1에 가까울수록 되돌림이 벌어짐의 주범)`);
})();
