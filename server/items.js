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
 *   duration : 지속시간 ms (0이면 즉발형, expire 호출 안 됨)
 *   apply(game, ball)  : 효과 시작. ball.plugin 에 상태 저장 가능
 *   expire(game, ball) : duration 경과 후 효과 해제 (즉발형이면 생략 가능)
 */

const Matter = require('matter-js');

const ITEMS = {
  // 1번: 3초간 물리엔진(핀/다른 공) 무시하고 그대로 떨어지기
  ghost: {
    id: 'ghost',
    name: '유령 낙하',
    emoji: '👻',
    desc: '3초간 핀과 다른 공을 무시하고 그대로 떨어집니다.',
    target: 'self',
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
    duration: 0,
    apply(game, ball) {
      // 내 공은 밀려나지 않음 (excludePlayerId)
      game.explodeAt(ball.position.x, ball.position.y, 200, 16, ball.plugin.playerId);
    },
  },

  // 6번: 상대방 공을 3초간 풍선처럼 커지고 잘 튀게 만들기
  balloon: {
    id: 'balloon',
    name: '풍선',
    emoji: '🎈',
    desc: '상대방의 공이 3초간 커져서 이리저리 튕겨다닙니다.',
    target: 'opponent',
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
  const { id, name, emoji, desc, target, duration } = item;
  return { id, name, emoji, desc, target, duration };
}

/** 랜덤 아이템 n개 뽑기 (중복 허용) */
function randomItems(n) {
  const keys = Object.keys(ITEMS);
  const picked = [];
  for (let i = 0; i < n; i++) {
    picked.push(keys[Math.floor(Math.random() * keys.length)]);
  }
  return picked;
}

module.exports = { ITEMS, itemMeta, randomItems };
