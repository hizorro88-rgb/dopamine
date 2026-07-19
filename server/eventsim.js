/**
 * 이벤트 추첨 모드: 낙하 시뮬레이션을 오프라인(실시간보다 빠르게)으로 돌려
 * 리플레이(프레임 + 이벤트 + 순위)를 녹화한다.
 * 수천 명의 시청자는 이 리플레이를 한 번만 내려받아 동기화된 시각에 재생한다.
 *
 * - 아이템은 자동 발동: 무작위 시점에 무작위 공이 무작위 아이템 사용
 * - 폭탄 등 반응형 구성요소도 라이브 게임과 동일하게 동작 (HIT_ACTIONS 재사용)
 */

const Matter = require('matter-js');
const { WORLD } = require('../public/components.js');
const {
  buildBoard,
  createBall,
  crossedFinish,
  wrapIfFallen,
  CAT_WALL,
  DEFAULT_MASK,
  BALL_RESTITUTION,
} = require('./board');
const { HIT_ACTIONS } = require('./game'); // 폭탄·점프패드 등 반응형 구성요소 동작 (아이템 아님)
const { TIME_SCALE } = require('./config'); // 이벤트 리플레이 녹화는 시작 시점 배속 상수 사용

const TICK_MS = 1000 / 60; // 물리 60Hz
const PHYSICS_SUBSTEPS = 4; // 물리 미세 분할 (라이브 게임과 동일: 터널링 방지)
// 재생은 게임 시간을 TIME_SCALE 배속으로 압축해 실제 20Hz 로 녹화
const FRAME_EVERY = 3 * TIME_SCALE;
const SIM_MAX_MS = 180000; // 시뮬레이션 최대 게임시간
const STEPS_PER_CHUNK = 240; // 이벤트 루프를 막지 않도록 청크 단위로 실행

/**
 * @param {object} mapDef 맵 정의
 * @param {Array<{id:number, name:string, color:string}>} participants
 * @param {function(pct:number)} onProgress
 * @returns {Promise<object>} replay
 */
async function simulateEvent(mapDef, participants, onProgress = () => {}) {
  const engine = Matter.Engine.create();
  engine.gravity.y = 1.05;
  engine.positionIterations = 10;
  engine.velocityIterations = 8;

  // 공을 위로 쌓아 스폰하므로 천장 없이 생성
  const built = buildBoard(engine, mapDef, { ceiling: false });
  const { goalY, height, finish } = built;

  let simNow = 0; // 시뮬레이션 게임시간(ms)
  const frames = [];
  const events = [];
  const finished = []; // 도착 순서 participant id
  const finishTimes = new Map();
  const activeEffects = []; // 반응형 맵 구성요소(폭탄 등)가 참조하는 효과 목록 (아이템 없음)
  const balls = new Map(); // participantId -> body

  // 아이템/반응형 구성요소가 기대하는 game 호환 컨텍스트
  const sim = {
    engine,
    CAT_WALL,
    DEFAULT_MASK,
    BALL_RESTITUTION,
    balls,
    height,
    width: built.board.world.width, // 🧲 자석 등 폭 인식 아이템용
    goalY,
    finishZone: finish, // 🧲 자석이 골인 x로 끌어당길 때 참조
    activeEffects,
    reactive: built.reactive,
    now: () => simNow,
    portalEffect(from, to) {
      events.push({ t: Math.round(simNow / TIME_SCALE), type: 'portal', from, to });
    },
    explodeAt(x, y, radius, power, excludePlayerId) {
      for (const [pid, ball] of balls) {
        if (ball.plugin.done || pid === excludePlayerId) continue;
        const dx = ball.position.x - x;
        const dy = ball.position.y - y;
        const dist = Math.hypot(dx, dy);
        if (dist > radius) continue;
        const dirX = dist > 1 ? dx / dist : 0;
        const dirY = dist > 1 ? dy / dist : -1;
        const v = power * (0.45 + 0.55 * (1 - dist / radius));
        Matter.Body.setVelocity(ball, {
          x: ball.velocity.x * 0.25 + dirX * v,
          y: ball.velocity.y * 0.25 + dirY * v,
        });
      }
      events.push({ t: Math.round(simNow / TIME_SCALE), type: 'explosion', x, y, radius });
    },
  };

  // 공 스폰: 격자로 위로 쌓기 (보드 위 화면 밖에서 쏟아져 내려옴)
  const cols = 15;
  participants.forEach((p, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 48 + col * 36 + (Math.random() - 0.5) * 8;
    const y = 60 - row * 34;
    const ball = createBall(x, y);
    ball.plugin = { playerId: p.id };
    balls.set(p.id, ball);
    Matter.Composite.add(engine.world, ball);
  });

  // 반응형 구성요소(폭탄) 충돌 감지 — 라이브 게임과 동일
  Matter.Events.on(engine, 'collisionStart', (ev) => {
    for (const pair of ev.pairs) {
      handleContact(pair.bodyA, pair.bodyB);
      handleContact(pair.bodyB, pair.bodyA);
    }
  });
  // 지속 접촉: 발사대 위에 공이 얹혀 끼는 것 방지 — 발사대가 있는 맵에서만 (핀 많은 맵 낭비 방지)
  const hasLaunchPads = [...built.reactive.values()].some((i) => i.hit && i.hit.action === 'launch');
  if (hasLaunchPads) {
    Matter.Events.on(engine, 'collisionActive', (ev) => {
      for (const pair of ev.pairs) {
        handleContact(pair.bodyA, pair.bodyB, true);
        handleContact(pair.bodyB, pair.bodyA, true);
      }
    });
  }
  function handleContact(a, b, activeOnly = false) {
    const inst = built.reactive.get((a.parent || a).id);
    if (!inst || inst.exploded) return;
    if (activeOnly && inst.hit.action !== 'launch') return; // 지속 접촉은 발사대만
    const ballBody = b.parent || b;
    if (!ballBody.plugin || ballBody.plugin.playerId === undefined) return;
    const action = HIT_ACTIONS[inst.hit.action];
    if (action) action(sim, inst, ballBody);
  }

  // 🎪 이벤트 추첨은 아이템 없이 진행한다 (수백 명 규모라 부하·변수를 줄이고
  //    순수 낙하 경쟁으로 단순화). 아이템 자동 발동·지속효과 로직을 두지 않는다.

  const nameOf = (pid) => {
    const p = participants.find((x) => x.id === pid);
    return p ? p.name : '?';
  };

  // 회전체·움직이는 벽을 지정한 게임시간(초) 자세로 맞춘다 (서브스텝 안에서 증분 호출)
  function setObstaclesTo(tSec) {
    for (const s of built.spinners) {
      const target = s.spin * tSec;
      Matter.Body.rotate(s.body, target - s.angle, s.pivot);
      s.angle = target;
    }
    for (const m of built.movers) {
      const off = Math.sin(tSec * m.speed) * m.range;
      Matter.Body.setPosition(m.body, {
        x: m.base.x + (m.axis === 'x' ? off : 0),
        y: m.base.y + (m.axis === 'y' ? off : 0),
      });
    }
  }

  // 회전 막대/십자 끝단·움직이는 벽의 최대 속도(px/s) — 적응형 서브스텝이 장애물
  // 이동량도 고려해 공을 지나쳐 통과하는 것을 막도록 미리 계산 (라이브 게임과 동일)
  let obstacleTipSpeed = 0;
  for (const s of built.spinners) {
    let reach = 0;
    const parts = s.body.parts || [s.body];
    for (const part of parts) {
      for (const v of part.vertices) {
        reach = Math.max(reach, Math.hypot(v.x - s.pivot.x, v.y - s.pivot.y));
      }
    }
    obstacleTipSpeed = Math.max(obstacleTipSpeed, Math.abs(s.spin) * reach);
  }
  for (const m of built.movers) {
    obstacleTipSpeed = Math.max(obstacleTipSpeed, Math.abs(m.speed) * m.range);
  }

  // ── 시뮬레이션 루프 (청크 단위로 이벤트 루프 양보) ──
  let step = 0;
  const maxSteps = Math.ceil(SIM_MAX_MS / TICK_MS);
  let lastSubCount = 1; // 적응형 물리 분할: 직전 스텝의 분할 수

  while (step < maxSteps) {
    const chunkEnd = Math.min(step + STEPS_PER_CHUNK, maxSteps);
    for (; step < chunkEnd; step++) {
      simNow = step * TICK_MS;
      // 회전체·움직이는 벽은 아래 서브스텝 루프 안에서 증분 이동한다(큰 각도 순간이동 시
      // 공을 그냥 지나쳐 통과하므로).

      // 폭탄 재생성
      for (const inst of built.reactive.values()) {
        if (inst.exploded && simNow >= inst.respawnAt) {
          inst.exploded = false;
          Matter.Composite.add(engine.world, inst.body);
        }
      }

      // (이벤트는 아이템 없음 — 지속효과·자동발동·얼림 로직 없음)

      // 갇힘 구출 (라이브 게임과 동일: 하강 진전 없고 거의 멈춘 공만 튕겨줌)
      for (const ball of balls.values()) {
        if (ball.plugin.done) continue;
        const progressed =
          ball.plugin.progressY === undefined || ball.position.y > ball.plugin.progressY + 6;
        const speed = Math.hypot(ball.velocity.x, ball.velocity.y);
        if (progressed || speed > 2.2) {
          if (ball.plugin.progressY === undefined || ball.position.y > ball.plugin.progressY) {
            ball.plugin.progressY = ball.position.y;
          }
          ball.plugin.stuckSince = simNow;
        } else if (simNow - ball.plugin.stuckSince > 5000) {
          Matter.Body.setVelocity(ball, {
            x: (Math.random() - 0.5) * 11,
            y: -5 - Math.random() * 3,
          });
          ball.plugin.stuckSince = simNow;
        }
      }

      // 🏁 골인 통과 판정을 위해 업데이트 직전 y 기록 + 최고 속도(적응형 분할용)
      let maxSpeed = 0;
      for (const ball of balls.values()) {
        if (ball.plugin.done) continue;
        ball.plugin.prevY = ball.position.y;
        if (ball.speed > maxSpeed) maxSpeed = ball.speed;
      }

      // 적응형 미세 분할 (라이브 게임과 동일: 검사 간 이동 ≤19px) — 공·장애물 이동량 모두 반영
      const ballDisp = maxSpeed * lastSubCount;
      const obstacleDisp = obstacleTipSpeed * (TICK_MS / 1000);
      const fullDisp = Math.max(ballDisp, obstacleDisp);
      const sub = Math.min(PHYSICS_SUBSTEPS, Math.max(1, Math.ceil(fullDisp / 19)));
      lastSubCount = sub;
      const subDt = TICK_MS / sub;
      for (let k = 0; k < sub; k++) {
        setObstaclesTo((simNow + subDt * (k + 1)) / 1000);
        Matter.Engine.update(engine, subDt);
      }

      // 도착/굴레 판정
      for (const [pid, ball] of balls) {
        if (ball.plugin.done) continue;
        // 골인 못 하고 바닥까지 떨어지면 → 속도·가로위치 그대로 최상단에서 다시 시작 (무한 굴레)
        if (!crossedFinish(ball, finish)) {
          wrapIfFallen(ball, height);
          continue;
        }
        ball.plugin.done = true;
        Matter.Composite.remove(engine.world, ball);
        finished.push(pid);
        finishTimes.set(pid, Math.round(simNow / TIME_SCALE));
        events.push({
          t: Math.round(simNow / TIME_SCALE),
          type: 'finish',
          p: pid,
          name: nameOf(pid),
          rank: finished.length,
          timeMs: Math.round(simNow / TIME_SCALE),
        });
      }

      // 프레임 녹화 (20Hz)
      if (step % FRAME_EVERY === 0) {
        const frameBalls = [];
        for (const [pid, ball] of balls) {
          if (ball.plugin.done) continue;
          // 이벤트는 아이템 없는 순수 낙하 → 상태 플래그는 항상 0
          // (클라 리플레이 포맷 호환을 위해 4번째 요소는 유지)
          frameBalls.push([
            pid,
            Math.round(ball.position.x * 10) / 10,
            Math.round(ball.position.y * 10) / 10,
            0,
          ]);
        }
        const off = [];
        for (const inst of built.reactive.values()) {
          if (inst.exploded) off.push(inst.index);
        }
        const frame = { t: Math.round(simNow / TIME_SCALE), e: Math.round(simNow), b: frameBalls };
        if (off.length) frame.off = off;
        frames.push(frame);
      }

      // 전원 도착 시 종료
      if (finished.length === balls.size) break;
    }
    if (finished.length === balls.size) break;
    onProgress(Math.min(99, Math.round((step / maxSteps) * 100)));
    await new Promise((r) => setImmediate(r));
  }

  const durationMs = Math.round(simNow / TIME_SCALE); // 재생(실제) 시간 기준

  // 최종 순위: 도착 순 → 미도착은 골인에 가까운 순
  const remaining = [...balls.entries()]
    .filter(([, b]) => !b.plugin.done)
    .sort((a, b) => b[1].position.y - a[1].position.y)
    .map(([pid]) => pid);
  const ranking = [...finished, ...remaining].map((pid, i) => {
    const p = participants.find((x) => x.id === pid);
    return {
      rank: i + 1,
      playerId: pid,
      name: p ? p.name : '?',
      color: p ? p.color : '#888',
      finished: i < finished.length,
      timeMs: finishTimes.has(pid) ? finishTimes.get(pid) : null,
    };
  });

  onProgress(100);
  return {
    version: 1,
    board: built.board,
    players: participants,
    frames,
    events,
    ranking,
    durationMs,
  };
}

module.exports = { simulateEvent };
