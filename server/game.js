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
const { ITEMS, itemMeta, randomItems, rollSpecialItem, SPECIAL_CHANCE } = require('./items');
const {
  buildBoard,
  createBall,
  crossedFinish,
  wrapIfFallen,
  CAT_WALL,
  DEFAULT_MASK,
  BALL_RESTITUTION,
} = require('./board');

const ITEMS_PER_PLAYER = 2; // 인당 랜덤 아이템 개수
// SPECIAL_CHANCE(신화·유일 게임당 지급 확률)는 items.js 에서 가져온다 — 도감 표시 확률과 일치시키기 위함
const MAX_BALLS_PER_PLAYER = 5; // 인당 공 개수 상한
const GAME_TIMEOUT_MS = 180000; // 낙하 후 제한시간 (넘으면 현재 위치로 순위 결정)
const STUCK_MS = 5000; // 이 게임 시간 동안 하강 진전이 없으면 갇힌 것으로 보고 튕겨준다
const STUCK_SPEED = 2.2; // 이 속도보다 빠르게 움직이는 공은 갇힌 게 아님 (활발히 튀는 공 오구출 방지)
const settings = require('./settings'); // 낙하배속·아이템소개·자동낙하 시간을 live 로 읽는다 (관리자 페이지에서 변경 가능)
const SHUFFLE_INTERVAL_MS = 1300; // 시작 배치 패턴 변경 주기

const TICK_MS = 1000 / 60; // 물리 60Hz
const SNAPSHOT_EVERY = 1; // 스냅샷 60Hz — 보간 구간이 절반(16.7ms)이라 더 부드럽고 지연도 낮출 수 있다
// 물리 미세 분할: 한 스텝(16.67ms)을 여러 번에 나눠 적분한다.
// 빠른 공이 한 스텝에 최대 38px 이동 → 두께 12~14px 벽을 그냥 통과(터널링)하던 버그 방지.
// 4분할이면 충돌 검사 사이 이동이 ≤9.5px로 가장 얇은 벽보다 짧아 공이 오브젝트를 뚫지 못한다.
// 시뮬 시간 총량은 동일하므로 낙하 속도·궤적 느낌은 그대로 유지된다.
const PHYSICS_SUBSTEPS = 4;

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

/** 무작위 패턴의 슬롯을 무작위 순서로 반환 (맵 폭 W 에 맞춰 가로로 펼침) */
function randomPatternSlots(n, W = 600) {
  const keys = Object.keys(SPAWN_PATTERNS);
  const slots = SPAWN_PATTERNS[keys[Math.floor(Math.random() * keys.length)]](n);
  // 패턴은 폭 600 기준으로 만들어졌으므로 실제 폭에 비례해 가로 위치를 늘린다
  if (W !== 600) {
    const k = W / 600;
    for (const s of slots) s.x *= k;
  }
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

  // 🌀 순간이동: 같은 채널의 다른 포탈로 (공마다 0.9초 쿨다운 — 왕복 무한루프 방지)
  teleport(game, inst, ball) {
    const now = game.now();
    if (ball.plugin.portalCdUntil && now < ball.plugin.portalCdUntil) return;
    let dest = null;
    for (const other of game.reactive.values()) {
      if (other !== inst && other.hit.action === 'teleport' && other.hit.channel === inst.hit.channel) {
        dest = other;
        break;
      }
    }
    if (!dest) return; // 짝이 없는 포탈은 장식
    ball.plugin.portalCdUntil = now + 900;
    const from = { x: ball.position.x, y: ball.position.y };
    const exit = { x: dest.x, y: dest.y + 36 };
    Matter.Body.setPosition(ball, exit);
    Matter.Body.setVelocity(ball, { x: ball.velocity.x * 0.3, y: Math.max(ball.velocity.y * 0.4, 2) });
    if (ball.plugin.frozenPos) ball.plugin.frozenPos = { ...exit };
    if (game.portalEffect) game.portalEffect(from, { x: dest.x, y: dest.y });
  },

  // 🦘 발사대: 공을 위로(각도만큼 옆으로) 쏘아 올린다
  launch(game, inst, ball) {
    const now = game.now();
    if (ball.plugin.padCdUntil && now < ball.plugin.padCdUntil) return;
    ball.plugin.padCdUntil = now + 300;
    Matter.Body.setVelocity(ball, {
      x: ball.velocity.x * 0.4 + (inst.hit.kickX || 0),
      y: -inst.hit.power,
    });
    if (game.portalEffect) game.portalEffect(null, { x: inst.x, y: inst.y - 12 });
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
    // 아이템전(기본) / 노템전 — 노템전이면 아이템·아이템 소개 없이 셔플→낙하만
    this.itemsEnabled = room.itemsEnabled !== false;
    // 인당 공 개수
    this.ballsPerPlayer = Math.min(
      Math.max(1, Number(room.ballsPerPlayer) || 1),
      MAX_BALLS_PER_PLAYER
    );

    this.CAT_WALL = CAT_WALL;
    this.DEFAULT_MASK = DEFAULT_MASK;
    this.BALL_RESTITUTION = BALL_RESTITUTION;

    this.engine = Matter.Engine.create();
    // 빠른 템포의 낙하 (공 크기 절반 + 3배 속도 튜닝)
    this.engine.gravity.y = 1.05;
    // 접촉 해결 반복을 늘려 빠른 공의 충돌을 더 안정적으로
    this.engine.positionIterations = 10;
    this.engine.velocityIterations = 8;

    this.balls = new Map(); // ballKey(playerId:idx) -> Matter body
    this.clones = []; // ✨ 분신: 임시 분신 바디들 (순위/도착에는 포함되지 않음)
    this.playerItems = new Map(); // playerId -> [itemId | null, ...]
    this.finished = []; // 도착 순서대로 ballKey
    this.finishTimes = new Map(); // ballKey -> 낙하 시작 후 완주 시간(ms)
    this.activeEffects = []; // { itemId, ball, until }
    this.startedAt = 0; // 실제 시각 (셔플 타이머용)
    this.dropAt = Infinity; // 실제 시각 (완주 기록용)
    this.simMs = 0; // 게임 시간 (물리 스텝마다 TICK_MS씩 증가)
    this.dropSimMs = 0;
    this.shuffling = true;
    this.shuffleTargets = new Map(); // ballKey -> {x, y}
    this.nextShuffleAt = 0;
    // 올랜덤: 시스템이 4~9초 사이 무작위 시점에 낙하
    this.shuffleLimitMs = this.autoPilot ? 4000 + Math.random() * 5000 : settings.get('shuffleAutoDropMs');
    this.autoTriggers = []; // 올랜덤 자동 아이템 스케줄
    this.speedMult = 1; // ⏩ 방장이 게임 중 올릴 수 있는 추가 배속 (1~3)
    // 🎁 아이템 소개 단계: 이 시각까지는 셔플·낙하가 잠긴다 (올랜덤은 아이템이 없으므로 생략)
    this.introUntil = 0;
    this.introDone = false;
    this.tickCount = 0;
    this.lastSubCount = 1; // 적응형 물리 분할: 직전 스텝의 분할 수
    this.interval = null;
    this.over = false;

    const built = buildBoard(this.engine, mapDef);
    this.board = built.board;
    this.spinners = built.spinners;
    this.movers = built.movers; // ↔️ 움직이는 벽
    this.reactive = built.reactive;
    this.height = built.height;
    this.width = built.board.world.width; // 맵 폭 (기본 600, 맵마다 가변)
    this.goalY = built.goalY;
    this.finishZone = built.finish; // 🏁 골인 존 {x,y,width,height} (finish() 메서드와 이름 충돌 주의)

    // 공 ↔ 반응형 구성요소 충돌 감지
    Matter.Events.on(this.engine, 'collisionStart', (ev) => {
      for (const pair of ev.pairs) {
        this.handleContact(pair.bodyA, pair.bodyB);
        this.handleContact(pair.bodyB, pair.bodyA);
      }
    });
    // 지속 접촉 감지는 '발사대'가 있는 맵에서만 켠다.
    //  collisionActive 는 매 틱 모든 접촉쌍에 대해 울리므로(핀 많은 맵은 수백 쌍),
    //  점프 패드가 없는 맵에서까지 돌리면 순수 낭비 → 서버 틱이 무거워져 화면이 밀린다.
    const hasLaunchPads = [...this.reactive.values()].some((i) => i.hit && i.hit.action === 'launch');
    if (hasLaunchPads) {
      Matter.Events.on(this.engine, 'collisionActive', (ev) => {
        for (const pair of ev.pairs) {
          this.handleContact(pair.bodyA, pair.bodyB, true);
          this.handleContact(pair.bodyB, pair.bodyA, true);
        }
      });
    }
  }

  /** a가 반응형 구성요소이고 b가 공이면 동작 발동.
   *  activeOnly=true(지속 접촉)면 '발사대'처럼 얹혀 끼는 걸 막아야 하는 동작만 재발동한다. */
  handleContact(a, b, activeOnly = false) {
    const inst = this.reactive.get((a.parent || a).id);
    if (!inst || inst.exploded) return;
    if (activeOnly && inst.hit.action !== 'launch') return; // 지속 접촉은 발사대만 (폭탄·포탈 재발동 방지)
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

  /** 🌀 포탈/점프 이펙트를 방 전체에 알림 */
  portalEffect(from, to) {
    this.io.to(this.room.code).emit('game:portal', { from, to });
  }

  /** 🌀 블랙홀 흡입 범위 시각 효과 (지속 시간 동안 소용돌이 장 표시) */
  blackholeEffect(x, y, radius, duration) {
    this.io.to(this.room.code).emit('game:blackhole', { x, y, radius, duration });
  }

  /** 게임 시간(ms) — 낙하 후에는 실제 시간보다 TIME_SCALE 배 빠르게 흐른다.
   *  아이템 지속시간·폭탄 재생성 등 게임 내 타이머는 전부 이 시계를 쓴다. */
  now() {
    return this.simMs;
  }

  /** 특정 플레이어의 아직 도착하지 않은 공들 */
  aliveBallsOf(playerId) {
    return [...this.balls.values()].filter(
      (b) => b.plugin.playerId === playerId && !b.plugin.done
    );
  }

  /** ✨ 분신: leadBall 위치에서 n개의 임시 분신을 만든다 (순위·도착 대상 아님) */
  spawnClones(leadBall, n, playerId) {
    if (!leadBall || leadBall.plugin.done) return;
    for (let i = 0; i < n; i++) {
      const c = createBall(leadBall.position.x, leadBall.position.y);
      c.plugin = {
        clone: true,
        playerId,
        ownerKey: leadBall.plugin.key,
        key: `${leadBall.plugin.key}:c${i}`,
      };
      // 좌우로 살짝 벌려 서로 다른 길을 탐색
      Matter.Body.setVelocity(c, {
        x: leadBall.velocity.x + (i % 2 === 0 ? -3.5 : 3.5) - 1 + i,
        y: leadBall.velocity.y,
      });
      this.clones.push(c);
      Matter.Composite.add(this.engine.world, c);
    }
  }

  /** ✨ 분신 종료: 실제 공 + 분신 중 가장 유리한 위치로 실제 공을 합치고 분신 제거 */
  mergeClones(leadBall) {
    if (!leadBall) return;
    const key = leadBall.plugin.key;
    const mine = this.clones.filter((c) => c.plugin.ownerKey === key && c.position.y < this.height);
    let best = leadBall;
    for (const b of [leadBall, ...mine]) {
      // 먼저 골인=골인에 가까운(y 큰) / 늦게 골인=골인에서 먼(y 작은) 쪽이 유리
      const better = this.winMode === 'last' ? b.position.y < best.position.y : b.position.y > best.position.y;
      if (better) best = b;
    }
    if (best !== leadBall && !leadBall.plugin.done) {
      const ny = this.winMode === 'last' ? best.position.y : Math.min(best.position.y, this.goalY - 20);
      Matter.Body.setPosition(leadBall, { x: best.position.x, y: ny });
      Matter.Body.setVelocity(leadBall, { x: best.velocity.x, y: best.velocity.y });
      leadBall.plugin.prevY = ny;
      if (leadBall.plugin.frozenPos) leadBall.plugin.frozenPos = { x: best.position.x, y: ny };
    }
    this.clones = this.clones.filter((c) => {
      if (c.plugin.ownerKey === key) {
        Matter.Composite.remove(this.engine.world, c);
        return false;
      }
      return true;
    });
  }

  clearClones() {
    for (const c of this.clones) Matter.Composite.remove(this.engine.world, c);
    this.clones = [];
  }

  /** 게임 시작: 공 생성(인당 N개), 아이템 배정, 셔플 단계 진입 */
  start() {
    const players = [...this.room.players.values()];

    for (const player of players) {
      for (let i = 0; i < this.ballsPerPlayer; i++) {
        const key = `${player.id}:${i}`;
        const ball = createBall(this.width / 2, 76);
        ball.plugin = { playerId: player.id, idx: i, key };
        this.balls.set(key, ball);
        Matter.Composite.add(this.engine.world, ball);
      }
      // 랜덤 아이템 배정 (공 개수와 무관하게 인당 2개) — 올랜덤·노템전은 아이템 없음
      const noItems = this.autoPilot || !this.itemsEnabled;
      this.playerItems.set(player.id, noItems ? [] : randomItems(ITEMS_PER_PLAYER));
    }

    // ★ 신화·유일 등급: 확률로 단 한 명에게만 하나 지급 (2인 이상, 올랜덤·노템전 제외)
    if (!this.autoPilot && this.itemsEnabled && players.length >= 2 && Math.random() < SPECIAL_CHANCE) {
      const specialId = rollSpecialItem();
      if (specialId) {
        const lucky = players[Math.floor(Math.random() * players.length)];
        this.playerItems.get(lucky.id).push(specialId);
      }
    }

    // 첫 배치 패턴을 즉시 적용
    this.assignShuffleTargets();
    for (const [key, ball] of this.balls) {
      Matter.Body.setPosition(ball, this.shuffleTargets.get(key));
    }

    this.startedAt = Date.now();
    // 아이템 소개는 아이템전에서만 (노템전·올랜덤은 소개 없이 바로 셔플)
    const introMs = settings.get('itemIntroMs');
    if (!this.autoPilot && this.itemsEnabled && introMs > 0) {
      this.introUntil = this.startedAt + introMs;
    }

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
        introMs: this.introUntil ? Math.max(0, this.introUntil - Date.now()) : 0,
        players: players.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          isDonor: !!p.isDonor,
        })),
        yourItems: items,
      });
    }

    // 관전자에게도 시작 정보 전송 (아이템 없음)
    if (this.room.spectators) {
      for (const specId of this.room.spectators.keys()) {
        this.io.to(specId).emit('game:started', this.spectatorPayload());
      }
    }

    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  /** 관전자용 시작 정보 — 중간 합류 시 현재까지의 도착 기록도 포함 */
  spectatorPayload() {
    const finished = this.finished.map((key, i) => {
      const ball = this.balls.get(key);
      const player = ball ? this.room.players.get(ball.plugin.playerId) : null;
      const name = player ? player.name : '?';
      return {
        playerId: ball ? ball.plugin.playerId : null,
        name: ball && this.ballsPerPlayer > 1 ? `${name} ${ball.plugin.idx + 1}번` : name,
        rank: i + 1,
        timeMs: this.finishTimes.get(key),
      };
    });
    return {
      board: this.board,
      winMode: this.winMode,
      ballsPerPlayer: this.ballsPerPlayer,
      shuffle: this.shuffling,
      autoPilot: this.autoPilot,
      introMs: this.introUntil ? Math.max(0, this.introUntil - Date.now()) : 0,
      spectator: true,
      players: [...this.room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        isDonor: !!p.isDonor,
      })),
      yourItems: [],
      finished,
    };
  }

  /** 새 배치 패턴을 골라 공들의 이동 목표를 재배정 */
  assignShuffleTargets() {
    const slots = randomPatternSlots(this.balls.size, this.width);
    let i = 0;
    for (const key of this.balls.keys()) {
      this.shuffleTargets.set(key, slots[i++]);
    }
    this.nextShuffleAt = Date.now() + SHUFFLE_INTERVAL_MS;
  }

  /** ⏩ 방장이 게임 중 배속 변경 (1~3배) */
  setSpeed(mult) {
    const m = Math.round(Number(mult));
    if (![1, 2, 3].includes(m) || this.over) return;
    if (m === this.speedMult) return;
    this.speedMult = m;
    this.io.to(this.room.code).emit('game:speed', { mult: m });
  }

  /** 방장이 낙하 버튼을 누른 순간 — 지금 위치 그대로 낙하 시작 */
  drop() {
    if (!this.shuffling || this.over) return;
    if (Date.now() < this.introUntil) return; // 🎁 아이템 소개 중에는 낙하 금지
    this.shuffling = false;
    this.dropAt = Date.now();
    this.dropSimMs = this.simMs;

    // 올랜덤: 자동 아이템 발동 스케줄 (게임 시간 기준 무작위 시점)
    if (this.autoPilot) {
      const count = Math.min(14, 3 + this.balls.size);
      // 시간이 아니라 선두 공의 깊이(맵 진행률) 기준으로 발동 —
      // 맵 길이·배속과 무관하게 경기 내내 골고루 터진다
      this.autoTriggers = Array.from({ length: count }, () => ({
        depth: (0.05 + Math.random() * 0.8) * this.goalY,
      })).sort((a, b) => a.depth - b.depth);
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

    if (this.shuffling) {
      // 셔플 단계: 실시간(1배속) — 배치 패턴 사이를 부드럽게 이동
      this.simMs += TICK_MS;
      this.rotateSpinners();
      const wall = Date.now();
      // 🎁 아이템 소개 중: 공은 제자리에 대기, 셔플·자동낙하 타이머 정지
      const inIntro = wall < this.introUntil;
      if (!inIntro && this.introUntil && !this.introDone) {
        this.introDone = true;
        this.startedAt = wall; // 소개가 끝난 시점부터 셔플 5초를 센다
      }
      if (!inIntro && wall >= this.nextShuffleAt) this.assignShuffleTargets();
      for (const [key, ball] of this.balls) {
        const target = this.shuffleTargets.get(key);
        Matter.Body.setVelocity(ball, { x: 0, y: 0 });
        Matter.Body.setPosition(ball, {
          x: ball.position.x + (target.x - ball.position.x) * 0.12,
          y: ball.position.y + (target.y - ball.position.y) * 0.12,
        });
      }
      Matter.Engine.update(this.engine, TICK_MS);
      // 방장이 너무 오래 안 누르면 자동 낙하 (올랜덤은 시스템이 4~9초에 낙하)
      if (!inIntro && wall - this.startedAt > this.shuffleLimitMs) this.drop();
    } else {
      // 낙하 단계: 낙하배속 × 방장 배속 — 틱당 서브스텝 반복 (배속은 관리자 설정에서 live)
      const steps = settings.get('timeScale') * this.speedMult;
      for (let i = 0; i < steps && !this.over; i++) this.substep();
      if (this.over) return;
    }

    // 스냅샷 전송 (30Hz, 실시간)
    this.tickCount++;
    if (this.tickCount % SNAPSHOT_EVERY === 0) {
      this.broadcastSnapshot();
    }
  }

  rotateSpinners() {
    const target = this.simMs / 1000;
    for (const s of this.spinners) {
      Matter.Body.rotate(s.body, s.spin * target - s.angle, s.pivot);
      s.angle = s.spin * target;
    }
    this.moveMovers(target);
  }

  /** ↔️ 움직이는 벽: 기준 위치에서 sin 파형으로 왕복 (게임 시간 기준 → 클라와 동기) */
  moveMovers(target = this.simMs / 1000) {
    if (!this.movers || !this.movers.length) return;
    for (const m of this.movers) {
      const off = Math.sin(target * m.speed) * m.range;
      Matter.Body.setPosition(m.body, {
        x: m.base.x + (m.axis === 'x' ? off : 0),
        y: m.base.y + (m.axis === 'y' ? off : 0),
      });
    }
  }

  /** 게임 시간 1스텝(TICK_MS) 진행 */
  substep() {
    this.simMs += TICK_MS;
    const sim = this.simMs;

    this.rotateSpinners();

    // 터진 반응형 구성요소 재생성 (게임 시간 기준)
    for (const inst of this.reactive.values()) {
      if (inst.exploded && sim >= inst.respawnAt) {
        inst.exploded = false;
        Matter.Composite.add(this.engine.world, inst.body);
      }
    }

    // 지속형 아이템 효과 만료 처리 (게임 시간 기준)
    this.activeEffects = this.activeEffects.filter((fx) => {
      if (sim >= fx.until) {
        const item = ITEMS[fx.itemId];
        if (item.expire && !fx.ball.plugin.done) item.expire(this, fx.ball);
        return false;
      }
      return true;
    });

    // 지속형 아이템 매 스텝 효과 (자석 끌림, 번개 감속 등)
    for (const fx of this.activeEffects) {
      const item = ITEMS[fx.itemId];
      if (item.tick && !fx.ball.plugin.done) item.tick(this, fx.ball);
    }

    // 올랜덤: 예정된 자동 아이템 발동 (선두 공의 깊이 기준)
    if (this.autoTriggers.length) {
      let lead = 0;
      for (const ball of this.balls.values()) {
        if (!ball.plugin.done && ball.position.y > lead) lead = ball.position.y;
      }
      while (this.autoTriggers.length && this.autoTriggers[0].depth <= lead) {
        this.autoTriggers.shift();
        this.autoFire();
      }
    }

    // 얼린 공 고정
    for (const ball of this.balls.values()) {
      if (!ball.plugin.done && ball.plugin.frozen && ball.plugin.frozenPos) {
        Matter.Body.setVelocity(ball, { x: 0, y: 0 });
        Matter.Body.setPosition(ball, ball.plugin.frozenPos);
      }
    }

    // 갇힘 구출: 게임 시간 5초 동안 "하강 진전도 없고 거의 멈춰 있으면" 살짝 튕겨준다.
    // (오목한 그림·범퍼 틈에 진짜로 낀 공만 대상 — 활발히 튀는 공은 건드리지 않아
    //  "아무데도 안 부딪혔는데 뜬금없이 위로 튀는" 현상을 막는다.)
    for (const ball of this.balls.values()) {
      if (ball.plugin.done || ball.plugin.frozen) continue;
      const progressed =
        ball.plugin.progressY === undefined || ball.position.y > ball.plugin.progressY + 6;
      const speed = Math.hypot(ball.velocity.x, ball.velocity.y);
      // 하강 중이거나(진전) 아직 충분히 움직이는 공은 갇힌 게 아니므로 타이머를 리셋
      if (progressed || speed > STUCK_SPEED) {
        if (ball.plugin.progressY === undefined || ball.position.y > ball.plugin.progressY) {
          ball.plugin.progressY = ball.position.y;
        }
        ball.plugin.stuckSince = sim;
      } else if (sim - ball.plugin.stuckSince > STUCK_MS) {
        Matter.Body.setVelocity(ball, {
          x: (Math.random() - 0.5) * 11,
          y: -5 - Math.random() * 3,
        });
        ball.plugin.stuckSince = sim;
      }
    }

    // 🏁 골인 통과 판정을 위해 업데이트 직전 y를 기록 (틱 사이 선 통과 감지)
    // + 가장 빠른 공의 속도를 함께 구해 이번 스텝의 미세 분할 수를 정한다(적응형).
    let maxSpeed = 0;
    for (const ball of this.balls.values()) {
      if (ball.plugin.done) continue;
      ball.plugin.prevY = ball.position.y;
      if (ball.speed > maxSpeed) maxSpeed = ball.speed;
    }

    // 적응형 미세 분할: 느린 공(대부분)은 1스텝, 빠른 공만 잘게 나눠 터널링 방지.
    // 직전 스텝의 분할 수로 '한 스텝당 이동량'을 환산 → 검사 간 이동 ≤19px 유지.
    // (충돌 감지 밴드 ≈26px, 19px/검사면 얇은 12~14px 벽도 확실히 잡힘 — 실측 0/40 통과)
    const fullDisp = maxSpeed * (this.lastSubCount || 1);
    const sub = Math.min(PHYSICS_SUBSTEPS, Math.max(1, Math.ceil(fullDisp / 19)));
    this.lastSubCount = sub;
    const subDt = TICK_MS / sub;
    for (let k = 0; k < sub; k++) Matter.Engine.update(this.engine, subDt);

    // 도착/굴레 판정
    for (const [key, ball] of this.balls) {
      if (ball.plugin.done) continue;
      // 골인 못 하고 바닥까지 떨어졌으면 → 속도·가로위치 그대로 최상단에서 다시 시작 (무한 굴레)
      if (!crossedFinish(ball, this.finishZone)) {
        wrapIfFallen(ball, this.height);
        continue;
      }
      {
        // 🎡 인생은 돌고돌아: 저주받은 공은 골인 대신 원점으로
        if (ball.plugin.karma) {
          ball.plugin.karma = false; // 1회성
          const player = this.room.players.get(ball.plugin.playerId);
          const name = player ? player.name : '?';
          Matter.Body.setPosition(ball, {
            x: 60 + Math.random() * (this.width - 120),
            y: 76,
          });
          Matter.Body.setVelocity(ball, { x: 0, y: 0 });
          ball.plugin.prevY = 76;
          if (ball.plugin.frozenPos) ball.plugin.frozenPos = { ...ball.position };
          this.io.to(this.room.code).emit('game:karma', {
            name: this.ballsPerPlayer > 1 ? `${name} ${ball.plugin.idx + 1}번` : name,
            x: this.width / 2,
            y: this.goalY - 40,
          });
          continue;
        }
        ball.plugin.done = true;
        Matter.Composite.remove(this.engine.world, ball);
        this.finished.push(key);
        this.finishTimes.set(key, Date.now() - this.dropAt); // 체감(실제) 시간 기록
        const player = this.room.players.get(ball.plugin.playerId);
        const name = player ? player.name : '?';
        // 🎉 축포: 먼저 골인 우승 → 첫 골인 / 늦게 골인 우승 → 마지막 골인 순간
        const allDoneNow = [...this.balls.values()].every((b) => b.plugin.done);
        const celebrate = this.winMode === 'last' ? allDoneNow : this.finished.length === 1;
        this.io.to(this.room.code).emit('game:ballFinished', {
          playerId: ball.plugin.playerId,
          ballIndex: ball.plugin.idx,
          name: this.ballsPerPlayer > 1 ? `${name} ${ball.plugin.idx + 1}번` : name,
          rank: this.finished.length,
          timeMs: this.finishTimes.get(key),
          celebrate,
          celebrateX: Math.round(ball.position.x),
        });
      }
    }

    // ✨ 분신 중 맵 밖으로 떨어진 것은 정리 (합쳐질 후보에서도 자연 제외)
    if (this.clones.length) {
      this.clones = this.clones.filter((c) => {
        if (c.position.y > this.height + 60) {
          Matter.Composite.remove(this.engine.world, c);
          return false;
        }
        return true;
      });
    }

    // 종료 판정: 전 공 도착 or 낙하 후 제한시간(게임 시간) 초과
    const allDone = [...this.balls.values()].every((b) => b.plugin.done);
    if (allDone || sim - this.dropSimMs > GAME_TIMEOUT_MS) {
      this.finish();
    }
  }

  broadcastSnapshot() {
    const balls = [];
    for (const ball of this.balls.values()) {
      if (ball.plugin.done) continue;
      const bp = ball.plugin;
      // 60Hz 전송을 가볍게: 0인 플래그는 생략(클라는 truthy 검사) — 대부분의 공은 x/y만 전송
      const e = {
        k: bp.key,
        p: bp.playerId,
        i: bp.idx,
        x: Math.round(ball.position.x * 10) / 10,
        y: Math.round(ball.position.y * 10) / 10,
      };
      if (bp.ghost) e.g = 1;
      if (bp.frozen) e.f = 1;
      if (bp.balloon) e.b = 1;
      if (bp.magnet) e.m = 1;
      if (bp.slowed) e.s = 1;
      if (bp.morph) e.o = bp.morph; // 🎭 변신 도형 (1~5)
      balls.push(e);
    }
    // ✨ 분신은 반투명 잔상으로만 표시 (도착·순위 대상 아님)
    for (const c of this.clones) {
      balls.push({
        k: c.plugin.key,
        p: c.plugin.playerId,
        x: Math.round(c.position.x * 10) / 10,
        y: Math.round(c.position.y * 10) / 10,
        cl: 1,
      });
    }
    // 현재 터져 있는(숨겨진) 반응형 구성요소 인덱스
    const off = [];
    for (const inst of this.reactive.values()) {
      if (inst.exploded) off.push(inst.index);
    }

    this.io.to(this.room.code).emit('game:snapshot', {
      t: Date.now(),
      elapsed: this.simMs, // 게임 시간 (회전 구성요소 각도 계산용)
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

    // 늦게 골인 우승은 아이템 의미가 뒤집히므로(느려질수록 유리) 대상을 자유 선택 —
    // 방해 아이템을 나에게, 가속 아이템을 상대에게 쓰는 전략이 가능해진다.
    let ballOwnerId;
    if (this.winMode === 'last') {
      ballOwnerId = targetId || playerId; // 지정 없으면 자신
    } else {
      ballOwnerId = item.target === 'opponent' ? targetId : playerId;
      if (item.target === 'opponent' && (!targetId || targetId === playerId)) {
        return '대상을 선택해주세요.';
      }
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
      self: ballOwnerId === playerId,
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
    this.clearClones();

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

    // 시리즈(여러 판) 진행 중이면 이번 판이 몇 번째인지 함께 알려 클라가 화면을 구분한다.
    const series = this.room.series
      ? { round: this.room.series.roundNo, total: this.room.series.total }
      : null;
    this.io.to(this.room.code).emit('game:over', { ranking, series });
    this.onGameOver(ranking);
  }

  stop() {
    this.over = true;
    clearInterval(this.interval);
    this.clearClones();
  }
}

module.exports = { Game, HIT_ACTIONS };
