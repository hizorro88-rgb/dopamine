/**
 * 아이템 레지스트리
 * ─────────────────
 * 새 아이템을 추가하려면 아래 ITEMS 객체에 항목 하나만 추가하면 됩니다.
 * 서버가 메타데이터(이름/이모지/설명/대상)를 클라이언트에 자동으로 내려주므로
 * 클라이언트 코드는 수정할 필요가 없습니다.
 *
 * 아이템 스키마:
 *   id       : 고유 키 (객체 키와 동일하게)
 *   name     : 표시 이름
 *   emoji    : 표시 이모지
 *   desc     : 설명 (아이템 버튼 툴팁 등)
 *   target   : 'self' | 'opponent'  — 대상 선택 UI가 자동으로 뜸
 *   grade    : 'normal' | 'epic' | 'legend'
 *              에픽은 등장 확률이 낮음. 레전드는 랜덤 풀에서 제외되고
 *              게임당 10% 확률로 단 한 명에게만 부여됨 (game.js KARMA_CHANCE)
 *   duration : 지속시간 ms (0이면 즉발형, expire 호출 안 됨)
 *   apply(game, ball, ctx)  : 효과 시작. ball.plugin 에 상태 저장 가능.
 *                             ctx.byPlayerId = 사용한 플레이어 (시스템 발동이면 없음)
 *   tick(game, ball)   : (선택) 지속시간 동안 매 물리 틱마다 호출
 *   expire(game, ball) : duration 경과 후 효과 해제 (즉발형이면 생략 가능)
 */

// 아이템 등장 가중치 (레전드는 풀에서 제외)
// 일반 4종 × 9 : 에픽 6종 × 2 = 36:12 → 에픽이 나올 확률 25%
const NORMAL_WEIGHT = 9;
const EPIC_WEIGHT = 2;

const Matter = require('matter-js');

const ITEMS = {
  // 1번: 3초간 물리엔진(핀/다른 공) 무시하고 그대로 떨어지기
  ghost: {
    id: 'ghost',
    name: '유령 낙하',
    emoji: '👻',
    desc: '3초간 핀과 다른 공을 무시하고 그대로 떨어집니다.',
    target: 'self',
    grade: 'epic',
    duration: 3000,
    apply(game, ball) {
      ball.plugin.ghost = true;
      // 외벽과만 충돌 → 핀과 다른 공은 통과
      ball.collisionFilter.mask = game.CAT_WALL;
      Matter.Body.setVelocity(ball, { x: 0, y: Math.max(ball.velocity.y, 2) });
    },
    expire(game, ball) {
      ball.plugin.ghost = false;
      ball.collisionFilter.mask = game.DEFAULT_MASK;
    },
  },

  // 2번: 상대방 공을 3초간 멈추기
  freeze: {
    id: 'freeze',
    name: '얼리기',
    emoji: '🧊',
    desc: '상대방의 공을 3초간 그 자리에 얼려버립니다.',
    target: 'opponent',
    grade: 'epic',
    duration: 3000,
    apply(game, ball) {
      ball.plugin.frozen = true;
      ball.plugin.frozenPos = { x: ball.position.x, y: ball.position.y };
      Matter.Body.setVelocity(ball, { x: 0, y: 0 });
    },
    expire(game, ball) {
      ball.plugin.frozen = false;
      ball.plugin.frozenPos = null;
    },
  },

  // 3번: 내 공을 아래로 강하게 가속
  rocket: {
    id: 'rocket',
    name: '로켓 부스트',
    emoji: '🚀',
    desc: '공이 아래 방향으로 강하게 가속합니다.',
    target: 'self',
    grade: 'normal',
    duration: 0,
    apply(game, ball) {
      Matter.Body.setVelocity(ball, { x: ball.velocity.x * 0.3, y: 18 });
    },
  },

  // 4번: 상대방 공을 위로 날려버리기
  gust: {
    id: 'gust',
    name: '돌풍',
    emoji: '🌪️',
    desc: '상대방의 공을 위로 확 날려버립니다.',
    target: 'opponent',
    grade: 'normal',
    duration: 0,
    apply(game, ball) {
      const dx = (Math.random() - 0.5) * 8;
      Matter.Body.setVelocity(ball, { x: dx, y: -14 });
    },
  },

  // 5번: 내 공 주변에 폭발을 일으켜 근처의 다른 공들을 날려버리기
  shockwave: {
    id: 'shockwave',
    name: '충격파',
    emoji: '💥',
    desc: '내 공 주변에 폭발을 일으켜 근처의 다른 공들을 날려버립니다.',
    target: 'self',
    grade: 'epic',
    duration: 0,
    apply(game, ball) {
      // 내 공은 밀려나지 않음 (excludePlayerId)
      game.explodeAt(ball.position.x, ball.position.y, 200, 16, ball.plugin.playerId);
    },
  },

  // 7번: 3초간 내 선두 공이 골인 쪽으로 강하게 끌려감
  magnet: {
    id: 'magnet',
    name: '자석',
    emoji: '🧲',
    desc: '3초간 내 공이 골인 지점으로 강하게 끌려갑니다.',
    target: 'self',
    grade: 'epic',
    duration: 3000,
    apply(game, ball) {
      ball.plugin.magnet = true;
    },
    tick(game, ball) {
      if (!ball.plugin.magnet) return;
      const pullX = (300 - ball.position.x) * 0.004;
      Matter.Body.setVelocity(ball, {
        x: ball.velocity.x * 0.92 + pullX,
        y: Math.min(ball.velocity.y + 0.45, 15),
      });
    },
    expire(game, ball) {
      ball.plugin.magnet = false;
    },
  },

  // 8번: 상대 선두 공과 내 선두 공의 위치를 맞바꾸기
  swap: {
    id: 'swap',
    name: '위치 교환',
    emoji: '🔀',
    desc: '상대방의 선두 공과 내 선두 공의 위치를 맞바꿉니다.',
    target: 'opponent',
    grade: 'epic',
    duration: 0,
    apply(game, ball, ctx) {
      // 내 선두 공 찾기 (시스템 발동이면 무작위 다른 공과 교환)
      let other = null;
      if (ctx && ctx.byPlayerId && game.aliveBallsOf) {
        const mine = game.aliveBallsOf(ctx.byPlayerId);
        if (mine.length) other = mine.reduce((a, b) => (b.position.y > a.position.y ? b : a));
      }
      if (!other) {
        const alive = [...game.balls.values()].filter((b) => !b.plugin.done && b !== ball);
        if (!alive.length) return;
        other = alive[Math.floor(Math.random() * alive.length)];
      }
      const p1 = { ...ball.position };
      const p2 = { ...other.position };
      const v1 = { ...ball.velocity };
      const v2 = { ...other.velocity };
      Matter.Body.setPosition(ball, p2);
      Matter.Body.setPosition(other, p1);
      Matter.Body.setVelocity(ball, v2);
      Matter.Body.setVelocity(other, v1);
      // 얼어있던 공은 고정 위치도 갱신
      if (ball.plugin.frozenPos) ball.plugin.frozenPos = { ...p2 };
      if (other.plugin.frozenPos) other.plugin.frozenPos = { ...p1 };
    },
  },

  // 9번: 상대 선두 공을 맵의 20% 만큼 위로 순간이동
  portal: {
    id: 'portal',
    name: '포탈',
    emoji: '🕳️',
    desc: '상대방의 선두 공을 한참 위로 되돌려보냅니다.',
    target: 'opponent',
    grade: 'normal',
    duration: 0,
    apply(game, ball) {
      const H = game.height || 2400;
      const newY = Math.max(140, ball.position.y - H * 0.22);
      Matter.Body.setPosition(ball, { x: ball.position.x, y: newY });
      Matter.Body.setVelocity(ball, { x: 0, y: 0 });
      if (ball.plugin.frozenPos) ball.plugin.frozenPos = { x: ball.position.x, y: newY };
    },
  },

  // 10번: 3초간 나를 제외한 모든 공 감속
  lightning: {
    id: 'lightning',
    name: '번개',
    emoji: '⚡',
    desc: '3초간 나를 제외한 모든 공이 찌릿— 느려집니다.',
    target: 'self',
    grade: 'epic',
    duration: 3000,
    apply(game, ball) {
      const myPid = ball.plugin.playerId;
      for (const b of game.balls.values()) {
        if (b.plugin.done || b.plugin.playerId === myPid) continue;
        b.plugin.slowed = true;
        game.activeEffects.push({ itemId: 'lightning', ball: b, until: game.now() + this.duration });
      }
    },
    tick(game, ball) {
      if (!ball.plugin.slowed) return;
      Matter.Body.setVelocity(ball, {
        x: ball.velocity.x * 0.88,
        y: Math.min(ball.velocity.y * 0.88, 2.5),
      });
    },
    expire(game, ball) {
      ball.plugin.slowed = false;
    },
  },

  // ★ 레전드: 인생은 돌고돌아 — 저주받은 공은 골인하는 순간 원점으로
  karma: {
    id: 'karma',
    name: '인생은 돌고돌아',
    emoji: '🎡',
    desc: '상대방의 공에 몰래 저주를 겁니다. 저주받은 공은 골인하는 순간... 처음부터 다시 시작합니다.',
    target: 'opponent',
    grade: 'legend',
    duration: 0,
    apply(game, ball) {
      ball.plugin.karma = true; // 발동은 game.js 도착 판정에서
    },
  },

  // 6번: 상대방 공을 3초간 풍선처럼 커지고 잘 튀게 만들기
  balloon: {
    id: 'balloon',
    name: '풍선',
    emoji: '🎈',
    desc: '상대방의 공이 3초간 커져서 이리저리 튕겨다닙니다.',
    target: 'opponent',
    grade: 'normal',
    duration: 3000,
    apply(game, ball) {
      ball.plugin.balloon = true;
      Matter.Body.scale(ball, 1.6, 1.6);
      ball.restitution = 1.05;
    },
    expire(game, ball) {
      ball.plugin.balloon = false;
      Matter.Body.scale(ball, 1 / 1.6, 1 / 1.6);
      ball.restitution = game.BALL_RESTITUTION;
    },
  },
};

/** 클라이언트에 내려줄 메타데이터 (apply/expire 함수 제외) */
function itemMeta(item) {
  const { id, name, emoji, desc, target, grade, duration } = item;
  return { id, name, emoji, desc, target, grade, duration };
}

/** 랜덤 아이템 n개 뽑기 (중복 허용, 등급 가중치 적용 — 레전드는 제외) */
function randomItems(n) {
  const pool = Object.values(ITEMS)
    .filter((item) => item.grade !== 'legend')
    .map((item) => ({
      id: item.id,
      weight: item.grade === 'epic' ? EPIC_WEIGHT : NORMAL_WEIGHT,
    }));
  const total = pool.reduce((sum, e) => sum + e.weight, 0);
  const picked = [];
  for (let i = 0; i < n; i++) {
    let r = Math.random() * total;
    let chosen = pool[pool.length - 1].id;
    for (const e of pool) {
      r -= e.weight;
      if (r <= 0) {
        chosen = e.id;
        break;
      }
    }
    picked.push(chosen);
  }
  return picked;
}

module.exports = { ITEMS, itemMeta, randomItems };
