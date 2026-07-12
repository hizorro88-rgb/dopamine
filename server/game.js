/**
 * 서버 권위(authoritative) 물리 시뮬레이션.
 * Matter.js 를 서버에서 돌리고 클라이언트에는 좌표 스냅샷만 전송한다.
 * → 모든 참가자가 완전히 동일한 게임을 보고, 클라이언트 부담이 거의 없다.
 *
 * 보드는 맵 정의(구성요소 목록)로부터 생성된다.
 * 구성요소의 도형(shapes)을 그대로 물리 바디로 변환하므로
 * public/components.js 에 새 구성요소를 추가하면 여기는 수정할 필요가 없다.
 */

const Matter = require('matter-js');
const { ITEMS, itemMeta, randomItems } = require('./items');
const { WORLD, buildShapes } = require('../public/components.js');

// 충돌 카테고리
const CAT_WALL = 0x0001; // 외벽 (유령 상태에서도 충돌)
const CAT_PEG = 0x0002; // 맵 구성요소 (유령 상태에서는 통과)
const CAT_BALL = 0x0004;
const DEFAULT_MASK = CAT_WALL | CAT_PEG | CAT_BALL;

const BALL_RADIUS = 13;
const BALL_RESTITUTION = 0.7;
const GOAL_MARGIN = 55; // 맵 바닥에서 이만큼 위가 골인선
const ITEMS_PER_PLAYER = 2; // 인당 랜덤 아이템 개수
const COUNTDOWN_MS = 3000; // 시작 카운트다운
const GAME_TIMEOUT_MS = 180000; // 제한시간 (넘으면 현재 위치로 순위 결정)

const TICK_MS = 1000 / 60; // 물리 60Hz
const SNAPSHOT_EVERY = 2; // 스냅샷 30Hz

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
  constructor(room, io, mapDef, onGameOver) {
    this.room = room;
    this.io = io;
    this.onGameOver = onGameOver;

    this.CAT_WALL = CAT_WALL;
    this.DEFAULT_MASK = DEFAULT_MASK;
    this.BALL_RESTITUTION = BALL_RESTITUTION;

    this.engine = Matter.Engine.create();
    // 중력을 낮춰 천천히 떨어지게 → 레이스가 길어지고 아이템 쓸 타이밍이 생김
    this.engine.gravity.y = 0.35;

    this.balls = new Map(); // playerId -> Matter body
    this.playerItems = new Map(); // playerId -> [itemId | null, ...]
    this.finished = []; // 도착 순서대로 playerId
    this.finishTimes = new Map(); // playerId -> 낙하 시작 후 완주 시간(ms)
    this.activeEffects = []; // { itemId, ball, until }
    this.spinners = []; // { body, spin, pivot, angle } — 회전 구성요소
    this.reactive = new Map(); // rootBodyId -> 반응형 구성요소 인스턴스 (폭탄 등)
    this.startedAt = 0;
    this.dropAt = 0;
    this.tickCount = 0;
    this.interval = null;
    this.over = false;

    this.board = this.buildBoard(mapDef);

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
    for (const [playerId, ball] of this.balls) {
      if (ball.plugin.done || playerId === excludePlayerId) continue;
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

  /** 맵 정의로부터 보드 생성. 클라이언트 렌더링용 데이터를 반환한다. */
  buildBoard(mapDef) {
    // 맵마다 길이가 다를 수 있음
    const H = Number(mapDef.height) || WORLD.height;
    this.height = H;
    this.goalY = H - GOAL_MARGIN;

    const bodies = [];
    const frame = [];

    // 외벽 (좌/우/천장) — 모든 맵 공통
    const addFrameWall = (x, y, w, h) => {
      bodies.push(
        Matter.Bodies.rectangle(x, y, w, h, {
          isStatic: true,
          collisionFilter: { category: CAT_WALL, mask: 0xffff },
        })
      );
      frame.push({ x, y, w, h, angle: 0 });
    };
    addFrameWall(-10, H / 2, 20, H * 2);
    addFrameWall(WORLD.width + 10, H / 2, 20, H * 2);
    addFrameWall(WORLD.width / 2, -10, WORLD.width * 2, 20);

    // 맵 구성요소 → 물리 바디 (도형을 그대로 변환)
    const renderComponents = [];
    for (const comp of mapDef.components) {
      const built = buildShapes(comp.type, comp.props);
      if (!built) continue; // 알 수 없는 타입은 무시

      const opts = {
        isStatic: true,
        restitution: built.restitution,
        collisionFilter: { category: CAT_PEG, mask: 0xffff },
      };
      const parts = built.shapes.map((s) =>
        s.kind === 'circle'
          ? Matter.Bodies.circle(comp.x + s.x, comp.y + s.y, s.r, opts)
          : Matter.Bodies.rectangle(comp.x + s.x, comp.y + s.y, s.w, s.h, {
              ...opts,
              angle: s.angle || 0,
            })
      );
      const body =
        parts.length === 1 ? parts[0] : Matter.Body.create({ parts, isStatic: true });
      bodies.push(body);

      // 회전 구성요소는 배치 지점을 축으로 매 틱 회전
      if (built.spin) {
        this.spinners.push({
          body,
          spin: built.spin,
          pivot: { x: comp.x, y: comp.y },
          angle: 0,
        });
      }

      // 반응형 구성요소(폭탄 등)는 충돌 감지 대상으로 등록
      if (built.hit) {
        this.reactive.set(body.id, {
          index: renderComponents.length, // 이 구성요소의 렌더링 인덱스
          body,
          x: comp.x,
          y: comp.y,
          hit: built.hit,
          exploded: false,
          respawnAt: 0,
        });
      }

      renderComponents.push({
        type: comp.type,
        x: comp.x,
        y: comp.y,
        shapes: built.shapes,
        spin: built.spin || 0,
      });
    }

    Matter.Composite.add(this.engine.world, bodies);

    return {
      world: { width: WORLD.width, height: H },
      frame,
      components: renderComponents,
      goal: { x: WORLD.width / 2, y: this.goalY, width: 236 },
      ballRadius: BALL_RADIUS,
      mapName: mapDef.name,
    };
  }

  /** 게임 시작: 공 생성, 아이템 배정, 루프 가동 */
  start() {
    const players = [...this.room.players.values()];

    // 공 스폰 위치를 섞어서 공평하게
    const slots = players.map((_, i) => i).sort(() => Math.random() - 0.5);
    const spanLeft = 70;
    const spanRight = WORLD.width - 70;

    players.forEach((player, i) => {
      const t = players.length === 1 ? 0.5 : slots[i] / (players.length - 1);
      const x = spanLeft + t * (spanRight - spanLeft) + (Math.random() - 0.5) * 10;
      const ball = Matter.Bodies.circle(x, 70, BALL_RADIUS, {
        restitution: BALL_RESTITUTION,
        friction: 0.02,
        frictionAir: 0.008,
        density: 0.0015,
        collisionFilter: { category: CAT_BALL, mask: DEFAULT_MASK },
      });
      ball.plugin = { playerId: player.id };
      this.balls.set(player.id, ball);
      Matter.Composite.add(this.engine.world, ball);

      // 랜덤 아이템 배정 (후원자는 에픽 아이템 확률 UP)
      this.playerItems.set(player.id, randomItems(ITEMS_PER_PLAYER, player.isDonor));
    });

    this.startedAt = this.now();
    this.dropAt = this.startedAt + COUNTDOWN_MS;

    // 각자에게 자기 아이템 포함 시작 정보 전송
    for (const player of players) {
      const items = this.playerItems
        .get(player.id)
        .map((id) => itemMeta(ITEMS[id]));
      this.io.to(player.id).emit('game:started', {
        board: this.board,
        countdownMs: COUNTDOWN_MS,
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

  tick() {
    if (this.over) return;
    const now = this.now();
    const elapsedSec = (now - this.startedAt) / 1000;

    // 카운트다운 후 낙하 시작
    const dropping = now >= this.dropAt;

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

    // 공 고정 처리 (카운트다운 대기 / 얼리기)
    for (const ball of this.balls.values()) {
      if (ball.plugin.done) continue;
      if (!dropping) {
        Matter.Body.setVelocity(ball, { x: 0, y: 0 });
        Matter.Body.setPosition(ball, ball.plugin.spawnPos || ball.position);
        if (!ball.plugin.spawnPos) ball.plugin.spawnPos = { ...ball.position };
      } else if (ball.plugin.frozen && ball.plugin.frozenPos) {
        Matter.Body.setVelocity(ball, { x: 0, y: 0 });
        Matter.Body.setPosition(ball, ball.plugin.frozenPos);
      }
    }

    Matter.Engine.update(this.engine, TICK_MS);

    // 도착 판정
    for (const [playerId, ball] of this.balls) {
      if (!ball.plugin.done && ball.position.y > this.goalY) {
        ball.plugin.done = true;
        Matter.Composite.remove(this.engine.world, ball);
        this.finished.push(playerId);
        this.finishTimes.set(playerId, now - this.dropAt); // 카운트다운 제외한 레이스 기록
        const player = this.room.players.get(playerId);
        this.io.to(this.room.code).emit('game:ballFinished', {
          playerId,
          name: player ? player.name : '?',
          rank: this.finished.length,
          timeMs: this.finishTimes.get(playerId),
        });
      }
    }

    // 종료 판정: 전원 도착 or 제한시간 초과
    const allDone = [...this.balls.values()].every((b) => b.plugin.done);
    if ((dropping && allDone) || now - this.startedAt > GAME_TIMEOUT_MS) {
      this.finish();
      return;
    }

    // 스냅샷 전송 (30Hz)
    this.tickCount++;
    if (this.tickCount % SNAPSHOT_EVERY === 0) {
      this.broadcastSnapshot(now, dropping);
    }
  }

  broadcastSnapshot(now, dropping) {
    const balls = [];
    for (const [playerId, ball] of this.balls) {
      if (ball.plugin.done) continue;
      balls.push({
        p: playerId,
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
      countdown: dropping ? 0 : Math.max(0, this.dropAt - now),
      balls,
      off,
    });
  }

  /**
   * 아이템 사용 요청 처리
   * @returns {string|null} 오류 메시지 (성공 시 null)
   */
  useItem(playerId, slotIndex, targetId) {
    if (this.over) return '게임이 끝났습니다.';
    const items = this.playerItems.get(playerId);
    if (!items || !items[slotIndex]) return '이미 사용한 아이템입니다.';
    if (this.now() < this.dropAt) return '카운트다운 중에는 사용할 수 없습니다.';

    const item = ITEMS[items[slotIndex]];
    const ballOwnerId = item.target === 'opponent' ? targetId : playerId;

    if (item.target === 'opponent') {
      if (!targetId || targetId === playerId) return '대상을 선택해주세요.';
      if (!this.balls.has(targetId)) return '대상이 없습니다.';
    }

    const ball = this.balls.get(ballOwnerId);
    if (!ball || ball.plugin.done) return '이미 도착한 공입니다.';

    items[slotIndex] = null; // 소모
    item.apply(this, ball);
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

  /** 플레이어 퇴장 시 공 제거 */
  removePlayer(playerId) {
    const ball = this.balls.get(playerId);
    if (ball && !ball.plugin.done) {
      ball.plugin.done = true;
      Matter.Composite.remove(this.engine.world, ball);
    }
    this.balls.delete(playerId);
    this.playerItems.delete(playerId);
    if (!this.over && this.balls.size === 0) this.finish();
  }

  finish() {
    if (this.over) return;
    this.over = true;
    clearInterval(this.interval);

    // 미도착 공은 골인 지점에 가까운 순서(y 큰 순)로 순위 부여
    const remaining = [...this.balls.entries()]
      .filter(([, b]) => !b.plugin.done)
      .sort((a, b) => b[1].position.y - a[1].position.y)
      .map(([id]) => id);

    const ranking = [...this.finished, ...remaining].map((playerId, i) => {
      const player = this.room.players.get(playerId);
      return {
        rank: i + 1,
        playerId,
        name: player ? player.name : '(나감)',
        color: player ? player.color : '#888',
        finished: i < this.finished.length,
        timeMs: this.finishTimes.has(playerId) ? this.finishTimes.get(playerId) : null,
      };
    });

    this.io.to(this.room.code).emit('game:over', { ranking });
    this.onGameOver();
  }

  stop() {
    this.over = true;
    clearInterval(this.interval);
  }
}

module.exports = { Game };
