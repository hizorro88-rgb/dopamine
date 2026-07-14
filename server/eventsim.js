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
const { ITEMS, itemMeta } = require('./items');
const { HIT_ACTIONS } = require('./game');
const { TIME_SCALE } = require('./config'); // 이벤트 리플레이 녹화는 시작 시점 배속 상수 사용

const TICK_MS = 1000 / 60; // 물리 60Hz
// 재생은 게임 시간을 TIME_SCALE 배속으로 압축해 실제 20Hz 로 녹화
const FRAME_EVERY = 3 * TIME_SCALE;
const SIM_MAX_MS = 180000; // 시뮬레이션 최대 게임시간
const MAX_AUTO_ITEMS = 40; // 자동 아이템 발동 최대 횟수 (토스트 도배 방지)
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
  const activeEffects = []; // { itemId, ball, until }
  const balls = new Map(); // participantId -> body

  // 아이템/반응형 구성요소가 기대하는 game 호환 컨텍스트
  const sim = {
    engine,
    CAT_WALL,
    DEFAULT_MASK,
    BALL_RESTITUTION,
    balls,
    height,
    goalY,
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
  // 지속 접촉: 발사대 위에 공이 얹혀 끼는 것 방지 (라이브 게임과 동일)
  Matter.Events.on(engine, 'collisionActive', (ev) => {
    for (const pair of ev.pairs) {
      handleContact(pair.bodyA, pair.bodyB, true);
      handleContact(pair.bodyB, pair.bodyA, true);
    }
  });
  function handleContact(a, b, activeOnly = false) {
    const inst = built.reactive.get((a.parent || a).id);
    if (!inst || inst.exploded) return;
    if (activeOnly && inst.hit.action !== 'launch') return; // 지속 접촉은 발사대만
    const ballBody = b.parent || b;
    if (!ballBody.plugin || ballBody.plugin.playerId === undefined) return;
    const action = HIT_ACTIONS[inst.hit.action];
    if (action) action(sim, inst, ballBody);
  }

  // 자동 아이템 발동 스케줄: 시뮬레이션 전체에 걸쳐 무작위 시점 (레전드 제외)
  const itemIds = Object.keys(ITEMS).filter((id) => ITEMS[id].grade !== 'legend');
  const triggerCount = Math.min(MAX_AUTO_ITEMS, Math.max(4, Math.floor(participants.length / 4)));
  const triggers = Array.from({ length: triggerCount }, () => ({
    t: 2000 + Math.random() * 70000,
    itemId: itemIds[Math.floor(Math.random() * itemIds.length)],
    fired: false,
  })).sort((a, b) => a.t - b.t);

  function fireTrigger(trigger) {
    const alive = [...balls.entries()].filter(([, b]) => !b.plugin.done);
    if (alive.length === 0) return;
    const item = ITEMS[trigger.itemId];
    const [byId] = alive[Math.floor(Math.random() * alive.length)];
    let targetId = byId;
    if (item.target === 'opponent') {
      const others = alive.filter(([pid]) => pid !== byId);
      if (others.length === 0) return;
      targetId = others[Math.floor(Math.random() * others.length)][0];
    }
    const ball = balls.get(targetId);
    item.apply(sim, ball);
    if (item.duration > 0) {
      activeEffects.push({ itemId: item.id, ball, until: simNow + item.duration });
    }
    const byName = nameOf(byId);
    events.push({
      t: Math.round(simNow / TIME_SCALE),
      type: 'item',
      by: byName,
      target: nameOf(targetId),
      self: item.target === 'self',
      item: itemMeta(item),
    });
  }

  const nameOf = (pid) => {
    const p = participants.find((x) => x.id === pid);
    return p ? p.name : '?';
  };

  // ── 시뮬레이션 루프 (청크 단위로 이벤트 루프 양보) ──
  let step = 0;
  let triggerIdx = 0;
  const maxSteps = Math.ceil(SIM_MAX_MS / TICK_MS);

  while (step < maxSteps) {
    const chunkEnd = Math.min(step + STEPS_PER_CHUNK, maxSteps);
    for (; step < chunkEnd; step++) {
      simNow = step * TICK_MS;

      // 회전 구성요소
      for (const s of built.spinners) {
        const target = s.spin * (simNow / 1000);
        Matter.Body.rotate(s.body, target - s.angle, s.pivot);
        s.angle = target;
      }

      // 폭탄 재생성
      for (const inst of built.reactive.values()) {
        if (inst.exploded && simNow >= inst.respawnAt) {
          inst.exploded = false;
          Matter.Composite.add(engine.world, inst.body);
        }
      }

      // 지속형 아이템 효과 만료
      for (let i = activeEffects.length - 1; i >= 0; i--) {
        const fx = activeEffects[i];
        if (simNow >= fx.until) {
          const item = ITEMS[fx.itemId];
          if (item.expire && !fx.ball.plugin.done) item.expire(sim, fx.ball);
          activeEffects.splice(i, 1);
        }
      }

      // 지속형 아이템 매 틱 효과 (자석, 번개 등)
      for (const fx of activeEffects) {
        const item = ITEMS[fx.itemId];
        if (item.tick && !fx.ball.plugin.done) item.tick(sim, fx.ball);
      }

      // 자동 아이템 발동
      while (triggerIdx < triggers.length && triggers[triggerIdx].t <= simNow) {
        fireTrigger(triggers[triggerIdx]);
        triggerIdx++;
      }

      // 얼린 공 고정
      for (const ball of balls.values()) {
        if (!ball.plugin.done && ball.plugin.frozen && ball.plugin.frozenPos) {
          Matter.Body.setVelocity(ball, { x: 0, y: 0 });
          Matter.Body.setPosition(ball, ball.plugin.frozenPos);
        }
      }

      // 갇힘 구출 (라이브 게임과 동일: 5초간 하강 진전 없으면 튕겨줌)
      for (const ball of balls.values()) {
        if (ball.plugin.done || ball.plugin.frozen) continue;
        if (ball.plugin.progressY === undefined || ball.position.y > ball.plugin.progressY + 6) {
          ball.plugin.progressY = ball.position.y;
          ball.plugin.stuckSince = simNow;
        } else if (simNow - ball.plugin.stuckSince > 5000) {
          Matter.Body.setVelocity(ball, {
            x: (Math.random() - 0.5) * 16,
            y: -6 - Math.random() * 4,
          });
          ball.plugin.stuckSince = simNow;
        }
      }

      // 🏁 골인 통과 판정을 위해 업데이트 직전 y 기록
      for (const ball of balls.values()) {
        if (!ball.plugin.done) ball.plugin.prevY = ball.position.y;
      }

      Matter.Engine.update(engine, TICK_MS);

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
          frameBalls.push([
            pid,
            Math.round(ball.position.x * 10) / 10,
            Math.round(ball.position.y * 10) / 10,
            (ball.plugin.ghost ? 1 : 0) | (ball.plugin.frozen ? 2 : 0) | (ball.plugin.balloon ? 4 : 0),
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
