/**
 * 서버 권위(authoritative) 물리 시뮬레이션.
 * Matter.js 를 서버에서 돌리고 클라이언트에는 좌표 스냅샷만 전송한다.
 * → 모든 참가자가 완전히 동일한 게임을 보고, 클라이언트 부담이 거의 없다.
 *
 * 게임 흐름:
 *   시작 → 셔플 단계 (공들이 배치 패턴 사이를 계속 이동, 전원이 관전)
 *        → 방장이 낙하 버튼 → 그 순간의 위치에서 낙하 시작 → 골인 순위
 *
 * 보드는 맵 정의(구성요소 목록)로부터 생성된다.
 * 구성요소의 도형(shapes)을 그대로 물리 바디로 변환하므로
 * public/components.js 에 새 구성요소를 추가하면 여기는 수정할 필요가 없다.
 */

const Matter = require('matter-js');
const { ITEMS, itemMeta, randomItems } = require('./items');
const {
  buildBoard,
  createBall,
  CAT_WALL,
  DEFAULT_MASK,
  BALL_RESTITUTION,
} = require('./board');

const ITEMS_PER_PLAYER = 2; // 인당 랜덤 아이템 개수
const KARMA_CHANCE = 0.1; // 🎡 인생은 돌고돌아: 게임당 이 확률로 단 한 명에게 부여
const MAX_BALLS_PER_PLAYER = 5; // 인당 공 개수 상한
const GAME_TIMEOUT_MS = 180000; // 낙하 후 제한시간 (넘으면 현재 위치로 순위 결정)
const SHUFFLE_MAX_MS = 45000; // 방장이 안 누르면 자동 낙하
const SHUFFLE_INTERVAL_MS = 1300; // 시작 배치 패턴 변경 주기

const TICK_MS = 1000 / 60; // 물리 60Hz
const SNAPSHOT_EVERY = 2; // 스냅샷 30Hz

// ── 시작 배치 패턴 ──────────────────────────────────────
// 셔플 단계에서 공들이 이 패턴들 사이를 계속 옮겨다니다가
// 방장이 낙하 버튼을 누르는 순간의 위치에서 시작된다.
// 새 패턴을 추가하려면 SPAWN_PATTERNS 에 함수 하나만 추가하면 된다.
const SPAWN = { minX: 40, maxX: 560, minY: 40, maxY: 112 };
const lerp = (a, b, t) => a + (b - a) * t;
const spread = (n, fn) =>
  Array.from({ length: n }, (_, i) => fn(n === 1 ? 0.5 : i / (n - 1), i));

const SPAWN_PATTERNS = {
  // 일렬
  line: (n) => spread(n, (t) => ({ x: lerp(SPAWN.minX, SPAWN.maxX, t), y: 76 })),
  // 지그재그 두 줄
  zigzag: (n) =>
    spread(n, (t, i) => ({
      x: lerp(SPAWN.minX, SPAWN.maxX, t),
      y: i % 2 === 0 ? SPAWN.minY + 14 : SPAWN.maxY - 14,
    })),
  // 타원형
  circle: (n) =>
    spread(n, (t) => ({
      x: 300 + Math.cos(t * Math.PI * 2) * 240,
      y: 76 + Math.sin(t * Math.PI * 2) * 33,
    })),
  // V자 (가운데가 아래)
  vshape: (n) =>
    spread(n, (t) => ({
      x: lerp(SPAWN.minX, SPAWN.maxX, t),
      y: lerp(SPAWN.maxY, SPAWN.minY, Math.abs(t - 0.5) * 2),
    })),
  // X자 (두 대각선 교차)
  xshape: (n) =>
    spread(n, (t, i) => ({
      x: lerp(SPAWN.minX, SPAWN.maxX, t),
      y: i % 2 === 0 ? lerp(SPAWN.minY, SPAWN.maxY, t) : lerp(SPAWN.maxY, SPAWN.minY, t),
    })),
  // 무작위 산개
  scatter: (n) =>
    Array.from({ length: n }, () => ({
      x: SPAWN.minX + Math.random() * (SPAWN.maxX - SPAWN.minX),
      y: SPAWN.minY + Math.random() * (SPAWN.maxY - SPAWN.minY),
    })),
};

/** 무작위 패턴의 슬롯을 무작위 순서로 반환 */
function randomPatternSlots(n) {
  const keys = Object.keys(SPAWN_PATTERNS);
  const slots = SPAWN_PATTERNS[keys[Math.floor(Math.random() * keys.length)]](n);
  return slots.sort(() => Math.random() - 0.5);
}

/**
 * 반응형 구성요소 동작: 구성요소의 hit.action 값으로 실행할 동작을 고른다.
 * 새 반응형 동작을 추가하려면 여기에 함수 하나만 추가하면 된다.
 */
const HIT_ACTIONS = {
  // 폭발: 범위 안의 모든 공에 방사형 물리력, 이후 재생성 대기
  explode(game, inst) {
    inst.exploded = true;
    inst.respawnAt =
      inst.hit.respawnMs > 0 ? game.now() + inst.hit.respawnMs : Infinity;
    Matter.Composite.remove(game.engine.world, inst.body);
    game.explodeAt(inst.x, inst.y, inst.hit.radius, inst.hit.power);
  },
};

class Game {
  /**
   * @param {object} room  rooms.js 의 방 객체
   * @param {import('socket.io').Server} io
   * @param {object} mapDef  maps.js 의 맵 정의 {id, name, components}
   * @param {function} onGameOver  게임 종료 콜백
   */
  constructor(room, io, mapDef, onGameOver, opts = {}) {
    this.room = room;
    this.io = io;
    this.onGameOver = onGameOver;
    // 올랜덤(오토파일럿): 시스템이 낙하 타이밍과 아이템을 결정, 전원 관전
    this.autoPilot = !!opts.autoPilot;
    // 우승 조건: 'first' = 먼저 골인한 순서 / 'last' = 늦게 골인한 순서
    this.winMode = room.winMode === 'last' ? 'last' : 'first';
    // 인당 공 개수
    this.ballsPerPlayer = Math.min(
      Math.max(1, Number(room.ballsPerPlayer) || 1),
      MAX_BALLS_PER_PLAYER
    );

    this.CAT_WALL = CAT_WALL;
    this.DEFAULT_MASK = DEFAULT_MASK;
    this.BALL_RESTITUTION = BALL_RESTITUTION;

    this.engine = Matter.Engine.create();
    // 중력을 낮춰 천천히 떨어지게 → 레이스가 길어지고 아이템 쓸 타이밍이 생김
    this.engine.gravity.y = 0.35;

    this.balls = new Map(); // ballKey(playerId:idx) -> Matter body
    this.playerItems = new Map(); // playerId -> [itemId | null, ...]
    this.finished = []; // 도착 순서대로 ballKey
    this.finishTimes = new Map(); // ballKey -> 낙하 시작 후 완주 시간(ms)
    this.activeEffects = []; // { itemId, ball, until }
    this.startedAt = 0;
    this.dropAt = Infinity; // 셔플 중에는 무한대 → drop() 시점에 확정
    this.shuffling = true;
    this.shuffleTargets = new Map(); // ballKey -> {x, y}
    this.nextShuffleAt = 0;
    // 올랜덤: 시스템이 4~9초 사이 무작위 시점에 낙하
    this.shuffleLimitMs = this.autoPilot ? 4000 + Math.random() * 5000 : SHUFFLE_MAX_MS;
    this.autoTriggers = []; // 올랜덤 자동 아이템 스케줄
    this.tickCount = 0;
    this.interval = null;
    this.over = false;

    const built = buildBoard(this.engine, mapDef);
    this.board = built.board;
    this.spinners = built.spinners;
    this.reactive = built.reactive;
    this.height = built.height;
    this.goalY = built.goalY;

    // 공 ↔ 반응형 구성요소 충돌 감지
    Matter.Events.on(this.engine, 'collisionStart', (ev) => {
      for (const pair of ev.pairs) {
        this.handleContact(pair.bodyA, pair.bodyB);
        this.handleContact(pair.bodyB, pair.bodyA);
      }
    });
  }

  /** a가 반응형 구성요소이고 b가 공이면 동작 발동 */
  handleContact(a, b) {
    const inst = this.reactive.get((a.parent || a).id);
    if (!inst || inst.exploded) return;
    const ballBody = b.parent || b;
    if (!ballBody.plugin || !ballBody.plugin.playerId) return;
    const action = HIT_ACTIONS[inst.hit.action];
    if (action) action(this, inst, ballBody);
  }

  /**
   * (x, y)에서 폭발: 범위 안의 모든 공이 중심 반대 방향으로 튕겨나간다.
   * 폭탄 구성요소와 충격파 아이템이 공용으로 사용.
   */
  explodeAt(x, y, radius, power, excludePlayerId) {
    for (const ball of this.balls.values()) {
      if (ball.plugin.done || ball.plugin.playerId === excludePlayerId) continue;
      const dx = ball.position.x - x;
      const dy = ball.position.y - y;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const dirX = dist > 1 ? dx / dist : 0;
      const dirY = dist > 1 ? dy / dist : -1;
      // 가까울수록 강하게
      const v = power * (0.45 + 0.55 * (1 - dist / radius));
      Matter.Body.setVelocity(ball, {
        x: ball.velocity.x * 0.25 + dirX * v,
        y: ball.velocity.y * 0.25 + dirY * v,
      });
    }
    this.io.to(this.room.code).emit('game:explosion', { x, y, radius });
  }

  now() {
    return Date.now();
  }

  /** 특정 플레이어의 아직 도착하지 않은 공들 */
  aliveBallsOf(playerId) {
    return [...this.balls.values()].filter(
      (b) => b.plugin.playerId === playerId && !b.plugin.done
    );
  }

  /** 게임 시작: 공 생성(인당 N개), 아이템 배정, 셔플 단계 진입 */
  start() {
    const players = [...this.room.players.values()];

    for (const player of players) {
      for (let i = 0; i < this.ballsPerPlayer; i++) {
        const key = `${player.id}:${i}`;
        const ball = createBall(300, 76);
        ball.plugin = { playerId: player.id, idx: i, key };
        this.balls.set(key, ball);
        Matter.Composite.add(this.engine.world, ball);
      }
      // 랜덤 아이템 배정 (공 개수와 무관하게 인당 2개, 올랜덤은 시스템이 대신 발동)
      this.playerItems.set(player.id, this.autoPilot ? [] : randomItems(ITEMS_PER_PLAYER));
    }

    // 🎡 인생은 돌고돌아: 10% 확률로 단 한 명에게만 (2인 이상, 올랜덤 제외)
    if (!this.autoPilot && players.length >= 2 && Math.random() < KARMA_CHANCE) {
      const lucky = players[Math.floor(Math.random() * players.length)];
      this.playerItems.get(lucky.id).push('karma');
    }

    // 첫 배치 패턴을 즉시 적용
    this.assignShuffleTargets();
    for (const [key, ball] of this.balls) {
      Matter.Body.setPosition(ball, this.shuffleTargets.get(key));
    }

    this.startedAt = this.now();

    // 각자에게 자기 아이템 포함 시작 정보 전송
    for (const player of players) {
      const items = this.playerItems
        .get(player.id)
        .map((id) => itemMeta(ITEMS[id]));
      this.io.to(player.id).emit('game:started', {
        board: this.board,
        winMode: this.winMode,
        ballsPerPlayer: this.ballsPerPlayer,
        shuffle: true,
        autoPilot: this.autoPilot,
        players: players.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          isDonor: !!p.isDonor,
        })),
        yourItems: items,
      });
    }

    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  /** 새 배치 패턴을 골라 공들의 이동 목표를 재배정 */
  assignShuffleTargets() {
    const slots = randomPatternSlots(this.balls.size);
    let i = 0;
    for (const key of this.balls.keys()) {
      this.shuffleTargets.set(key, slots[i++]);
    }
    this.nextShuffleAt = this.now() + SHUFFLE_INTERVAL_MS;
  }

  /** 방장이 낙하 버튼을 누른 순간 — 지금 위치 그대로 낙하 시작 */
  drop() {
    if (!this.shuffling || this.over) return;
    this.shuffling = false;
    this.dropAt = this.now();

    // 올랜덤: 자동 아이템 발동 스케줄 (낙하 후 무작위 시점)
    if (this.autoPilot) {
      const count = Math.min(14, 3 + this.balls.size);
      this.autoTriggers = Array.from({ length: count }, () => ({
        t: this.dropAt + 2000 + Math.random() * 28000,
        fired: false,
      })).sort((a, b) => a.t - b.t);
    }
  }

  /** 올랜덤: 무작위 아이템을 무작위 공에 발동 (레전드 제외) */
  autoFire() {
    const alive = [...this.balls.values()].filter((b) => !b.plugin.done);
    if (alive.length === 0) return;
    const itemIds = Object.keys(ITEMS).filter((id) => ITEMS[id].grade !== 'legend');
    const item = ITEMS[itemIds[Math.floor(Math.random() * itemIds.length)]];
    const ball = alive[Math.floor(Math.random() * alive.length)];
    item.apply(this, ball);
    if (item.duration > 0) {
      this.activeEffects.push({ itemId: item.id, ball, until: this.now() + item.duration });
    }
    const owner = this.room.players.get(ball.plugin.playerId);
    this.io.to(this.room.code).emit('game:itemUsed', {
      by: '🎲 운명',
      item: itemMeta(item),
      target: owner ? owner.name : '?',
      self: false,
    });
  }

  tick() {
    if (this.over) return;
    const now = this.now();
    const elapsedSec = (now - this.startedAt) / 1000;
    const dropping = !this.shuffling;

    // 회전 구성요소 회전 (경과 시간 기반 → 클라이언트와 결정적으로 동기화)
    for (const s of this.spinners) {
      const target = s.spin * elapsedSec;
      Matter.Body.rotate(s.body, target - s.angle, s.pivot);
      s.angle = target;
    }

    // 터진 반응형 구성요소 재생성
    for (const inst of this.reactive.values()) {
      if (inst.exploded && now >= inst.respawnAt) {
        inst.exploded = false;
        Matter.Composite.add(this.engine.world, inst.body);
      }
    }

    // 지속형 아이템 효과 만료 처리
    this.activeEffects = this.activeEffects.filter((fx) => {
      if (now >= fx.until) {
        const item = ITEMS[fx.itemId];
        if (item.expire && !fx.ball.plugin.done) item.expire(this, fx.ball);
        return false;
      }
      return true;
    });

    // 지속형 아이템 매 틱 효과 (자석 끌림, 번개 감속 등)
    for (const fx of this.activeEffects) {
      const item = ITEMS[fx.itemId];
      if (item.tick && !fx.ball.plugin.done) item.tick(this, fx.ball);
    }

    if (this.shuffling) {
      // 셔플 단계: 주기적으로 새 패턴 배정, 공들은 목표 위치로 부드럽게 이동
      if (now >= this.nextShuffleAt) this.assignShuffleTargets();
      for (const [key, ball] of this.balls) {
        const target = this.shuffleTargets.get(key);
        Matter.Body.setVelocity(ball, { x: 0, y: 0 });
        Matter.Body.setPosition(ball, {
          x: ball.position.x + (target.x - ball.position.x) * 0.12,
          y: ball.position.y + (target.y - ball.position.y) * 0.12,
        });
      }
      // 방장이 너무 오래 안 누르면 자동 낙하 (올랜덤은 시스템이 4~9초에 낙하)
      if (now - this.startedAt > this.shuffleLimitMs) this.drop();
    } else {
      // 올랜덤: 예정된 자동 아이템 발동
      while (this.autoTriggers.length && this.autoTriggers[0].t <= now) {
        this.autoTriggers.shift();
        this.autoFire();
      }
      // 얼린 공 고정
      for (const ball of this.balls.values()) {
        if (!ball.plugin.done && ball.plugin.frozen && ball.plugin.frozenPos) {
          Matter.Body.setVelocity(ball, { x: 0, y: 0 });
          Matter.Body.setPosition(ball, ball.plugin.frozenPos);
        }
      }
    }

    Matter.Engine.update(this.engine, TICK_MS);

    // 도착 판정
    if (dropping) {
      for (const [key, ball] of this.balls) {
        if (!ball.plugin.done && ball.position.y > this.goalY) {
          // 🎡 인생은 돌고돌아: 저주받은 공은 골인 대신 원점으로
          if (ball.plugin.karma) {
            ball.plugin.karma = false; // 1회성
            const player = this.room.players.get(ball.plugin.playerId);
            const name = player ? player.name : '?';
            Matter.Body.setPosition(ball, {
              x: 60 + Math.random() * 480,
              y: 76,
            });
            Matter.Body.setVelocity(ball, { x: 0, y: 0 });
            if (ball.plugin.frozenPos) ball.plugin.frozenPos = { ...ball.position };
            this.io.to(this.room.code).emit('game:karma', {
              name: this.ballsPerPlayer > 1 ? `${name} ${ball.plugin.idx + 1}번` : name,
              x: 300,
              y: this.goalY - 40,
            });
            continue;
          }
          ball.plugin.done = true;
          Matter.Composite.remove(this.engine.world, ball);
          this.finished.push(key);
          this.finishTimes.set(key, now - this.dropAt);
          const player = this.room.players.get(ball.plugin.playerId);
          const name = player ? player.name : '?';
          this.io.to(this.room.code).emit('game:ballFinished', {
            playerId: ball.plugin.playerId,
            ballIndex: ball.plugin.idx,
            name: this.ballsPerPlayer > 1 ? `${name} ${ball.plugin.idx + 1}번` : name,
            rank: this.finished.length,
            timeMs: this.finishTimes.get(key),
          });
        }
      }
    }

    // 종료 판정: 전 공 도착 or 낙하 후 제한시간 초과
    const allDone = [...this.balls.values()].every((b) => b.plugin.done);
    if ((dropping && allDone) || (dropping && now - this.dropAt > GAME_TIMEOUT_MS)) {
      this.finish();
      return;
    }

    // 스냅샷 전송 (30Hz)
    this.tickCount++;
    if (this.tickCount % SNAPSHOT_EVERY === 0) {
      this.broadcastSnapshot(now);
    }
  }

  broadcastSnapshot(now) {
    const balls = [];
    for (const ball of this.balls.values()) {
      if (ball.plugin.done) continue;
      balls.push({
        k: ball.plugin.key,
        p: ball.plugin.playerId,
        i: ball.plugin.idx,
        x: Math.round(ball.position.x * 10) / 10,
        y: Math.round(ball.position.y * 10) / 10,
        g: ball.plugin.ghost ? 1 : 0,
        f: ball.plugin.frozen ? 1 : 0,
        b: ball.plugin.balloon ? 1 : 0,
      });
    }
    // 현재 터져 있는(숨겨진) 반응형 구성요소 인덱스
    const off = [];
    for (const inst of this.reactive.values()) {
      if (inst.exploded) off.push(inst.index);
    }

    this.io.to(this.room.code).emit('game:snapshot', {
      t: now,
      elapsed: now - this.startedAt, // 회전 구성요소 각도 계산용
      sh: this.shuffling ? 1 : 0,
      countdown: 0,
      balls,
      off,
    });
  }

  /**
   * 아이템 사용 요청 처리 — 효과는 해당 플레이어의 선두 공에 적용
   * @returns {string|null} 오류 메시지 (성공 시 null)
   */
  useItem(playerId, slotIndex, targetId) {
    if (this.over) return '게임이 끝났습니다.';
    const items = this.playerItems.get(playerId);
    if (!items || !items[slotIndex]) return '이미 사용한 아이템입니다.';
    if (this.shuffling) return '아직 시작 전입니다.';

    const item = ITEMS[items[slotIndex]];
    const ballOwnerId = item.target === 'opponent' ? targetId : playerId;

    if (item.target === 'opponent') {
      if (!targetId || targetId === playerId) return '대상을 선택해주세요.';
    }

    // 선두(골인에 가장 가까운) 공에 적용
    const alive = this.aliveBallsOf(ballOwnerId);
    if (alive.length === 0) return '이미 도착한 공입니다.';
    const ball = alive.reduce((a, b) => (b.position.y > a.position.y ? b : a));

    items[slotIndex] = null; // 소모
    item.apply(this, ball, { byPlayerId: playerId });
    if (item.duration > 0) {
      this.activeEffects.push({
        itemId: item.id,
        ball,
        until: this.now() + item.duration,
      });
    }

    const byPlayer = this.room.players.get(playerId);
    const targetPlayer = this.room.players.get(ballOwnerId);
    this.io.to(this.room.code).emit('game:itemUsed', {
      by: byPlayer ? byPlayer.name : '?',
      item: itemMeta(item),
      target: targetPlayer ? targetPlayer.name : '?',
      self: item.target === 'self',
    });
    return null;
  }

  /** 플레이어 퇴장 시 공 전부 제거 */
  removePlayer(playerId) {
    for (const [key, ball] of [...this.balls]) {
      if (ball.plugin.playerId !== playerId) continue;
      if (!ball.plugin.done) Matter.Composite.remove(this.engine.world, ball);
      this.balls.delete(key);
      this.shuffleTargets.delete(key);
    }
    this.playerItems.delete(playerId);
    if (!this.over && this.balls.size === 0) this.finish();
  }

  finish() {
    if (this.over) return;
    this.over = true;
    clearInterval(this.interval);

    // 공 단위 순서 계산 (기존 우승 조건 로직)
    const remaining = [...this.balls.entries()].filter(([, b]) => !b.plugin.done);
    let ballOrder;
    if (this.winMode === 'last') {
      // 늦게 골인 우승: 제한시간까지 미도착(위쪽일수록 유리) → 늦게 도착한 순
      const remainingSorted = remaining
        .sort((a, b) => a[1].position.y - b[1].position.y)
        .map(([key]) => key);
      ballOrder = [...remainingSorted, ...[...this.finished].reverse()];
    } else {
      // 먼저 골인 우승: 도착 순 → 미도착은 골인 지점에 가까운 순(y 큰 순)
      const remainingSorted = remaining
        .sort((a, b) => b[1].position.y - a[1].position.y)
        .map(([key]) => key);
      ballOrder = [...this.finished, ...remainingSorted];
    }

    // 플레이어 단위로 축약: 각 플레이어의 가장 좋은 공이 그 플레이어의 성적
    const finishedSet = new Set(this.finished);
    const seen = new Set();
    const playerOrder = [];
    for (const key of ballOrder) {
      const ball = this.balls.get(key);
      if (!ball) continue; // 나간 플레이어의 공
      const pid = ball.plugin.playerId;
      if (seen.has(pid)) continue;
      seen.add(pid);
      playerOrder.push({ pid, key });
    }

    const ranking = playerOrder.map(({ pid, key }, i) => {
      const player = this.room.players.get(pid);
      return {
        rank: i + 1,
        playerId: pid,
        name: player ? player.name : '(나감)',
        color: player ? player.color : '#888',
        finished: finishedSet.has(key),
        timeMs: this.finishTimes.has(key) ? this.finishTimes.get(key) : null,
      };
    });

    this.io.to(this.room.code).emit('game:over', { ranking });
    this.onGameOver(ranking);
  }

  stop() {
    this.over = true;
    clearInterval(this.interval);
  }
}

module.exports = { Game, HIT_ACTIONS };
