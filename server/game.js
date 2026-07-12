/**
 * 서버 권위(authoritative) 물리 시뮬레이션.
 * Matter.js 를 서버에서 돌리고 클라이언트에는 좌표 스냅샷만 전송한다.
 * → 모든 참가자가 완전히 동일한 게임을 보고, 클라이언트 부담이 거의 없다.
 */

const Matter = require('matter-js');
const { ITEMS, itemMeta, randomItems } = require('./items');

const WORLD = { width: 600, height: 900 };

// 충돌 카테고리
const CAT_WALL = 0x0001;
const CAT_PEG = 0x0002;
const CAT_BALL = 0x0004;
const DEFAULT_MASK = CAT_WALL | CAT_PEG | CAT_BALL;

const BALL_RADIUS = 13;
const BALL_RESTITUTION = 0.7;
const GOAL_Y = 845; // 이 선을 넘으면 도착
const ITEMS_PER_PLAYER = 2; // 인당 랜덤 아이템 개수
const COUNTDOWN_MS = 3000; // 시작 카운트다운
const GAME_TIMEOUT_MS = 120000; // 제한시간 (넘으면 현재 위치로 순위 결정)

const TICK_MS = 1000 / 60; // 물리 60Hz
const SNAPSHOT_EVERY = 2; // 스냅샷 30Hz

class Game {
  /**
   * @param {object} room  rooms.js 의 방 객체
   * @param {import('socket.io').Server} io
   * @param {function} onGameOver  게임 종료 콜백
   */
  constructor(room, io, onGameOver) {
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
    this.activeEffects = []; // { itemId, ball, until }
    this.startedAt = 0;
    this.dropAt = 0;
    this.tickCount = 0;
    this.interval = null;
    this.over = false;

    this.board = this.buildBoard();
  }

  now() {
    return Date.now();
  }

  /** 핀볼 보드 생성. 렌더링용 도형 정보를 반환한다. */
  buildBoard() {
    const bodies = [];
    const walls = [];
    const pegs = [];

    const addWall = (x, y, w, h, angle = 0) => {
      const body = Matter.Bodies.rectangle(x, y, w, h, {
        isStatic: true,
        angle,
        collisionFilter: { category: CAT_WALL, mask: 0xffff },
      });
      bodies.push(body);
      walls.push({ x, y, w, h, angle });
    };

    // 외벽 (좌/우/천장)
    addWall(-10, WORLD.height / 2, 20, WORLD.height * 2);
    addWall(WORLD.width + 10, WORLD.height / 2, 20, WORLD.height * 2);
    addWall(WORLD.width / 2, -10, WORLD.width * 2, 20);

    // 핀(peg) — 지그재그 격자
    const pegR = 8;
    let row = 0;
    for (let y = 170; y <= 640; y += 58) {
      const offset = row % 2 === 0 ? 0 : 29;
      for (let x = 55 + offset; x <= WORLD.width - 55; x += 58) {
        const body = Matter.Bodies.circle(x, y, pegR, {
          isStatic: true,
          restitution: 0.5,
          collisionFilter: { category: CAT_PEG, mask: 0xffff },
        });
        bodies.push(body);
        pegs.push({ x, y, r: pegR });
      }
      row++;
    }

    // 깔때기 (골인 지점으로 좁아지는 경사벽)
    const funnelAngle = Math.atan2(120, 230);
    const funnelLen = Math.hypot(230, 120) + 30;
    addWall(115, 745, funnelLen, 14, funnelAngle);
    addWall(WORLD.width - 115, 745, funnelLen, 14, -funnelAngle);

    // 골인 통로 세로 가이드
    addWall(232, 835, 14, 70);
    addWall(WORLD.width - 232, 835, 14, 70);

    Matter.Composite.add(this.engine.world, bodies);

    return {
      world: WORLD,
      walls,
      pegs,
      goal: { x: WORLD.width / 2, y: GOAL_Y, width: WORLD.width - 464 + 100 },
      ballRadius: BALL_RADIUS,
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
      ball.plugin = { playerId: player.id, held: true };
      this.balls.set(player.id, ball);
      Matter.Composite.add(this.engine.world, ball);

      // 랜덤 아이템 배정
      this.playerItems.set(player.id, randomItems(ITEMS_PER_PLAYER));
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
        players: players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
        yourItems: items,
      });
    }

    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  tick() {
    if (this.over) return;
    const now = this.now();

    // 카운트다운 후 낙하 시작
    const dropping = now >= this.dropAt;

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
      if (!ball.plugin.done && ball.position.y > GOAL_Y) {
        ball.plugin.done = true;
        Matter.Composite.remove(this.engine.world, ball);
        this.finished.push(playerId);
        const player = this.room.players.get(playerId);
        this.io.to(this.room.code).emit('game:ballFinished', {
          playerId,
          name: player ? player.name : '?',
          rank: this.finished.length,
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
    this.io.to(this.room.code).emit('game:snapshot', {
      t: now,
      countdown: dropping ? 0 : Math.max(0, this.dropAt - now),
      balls,
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
