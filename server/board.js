/**
 * 맵 정의 → 물리 보드 생성 (라이브 게임과 이벤트 시뮬레이터가 공유)
 */

const Matter = require('matter-js');
const { WORLD, buildShapes } = require('../public/components.js');

// 충돌 카테고리
const CAT_WALL = 0x0001; // 외벽 (유령 상태에서도 충돌)
const CAT_PEG = 0x0002; // 맵 구성요소 (유령 상태에서는 통과)
const CAT_BALL = 0x0004;
const DEFAULT_MASK = CAT_WALL | CAT_PEG | CAT_BALL;

const BALL_RADIUS = 13;
const BALL_RESTITUTION = 0.7;
const GOAL_MARGIN = 55; // 맵 바닥에서 이만큼 위가 골인선

/**
 * 엔진에 맵을 구성하고 렌더링 데이터를 반환한다.
 * @param {object} opts.ceiling  천장 생성 여부 (이벤트 모드는 공을 위로 쌓으므로 false)
 * @returns {{ board, spinners, reactive, height, goalY }}
 */
function buildBoard(engine, mapDef, { ceiling = true } = {}) {
  const H = Number(mapDef.height) || WORLD.height;
  const goalY = H - GOAL_MARGIN;

  const bodies = [];
  const frame = [];
  const spinners = []; // { body, spin, pivot, angle }
  const reactive = new Map(); // rootBodyId -> 반응형 구성요소 인스턴스 (폭탄 등)

  const addFrameWall = (x, y, w, h) => {
    bodies.push(
      Matter.Bodies.rectangle(x, y, w, h, {
        isStatic: true,
        collisionFilter: { category: CAT_WALL, mask: 0xffff },
      })
    );
    frame.push({ x, y, w, h, angle: 0 });
  };
  addFrameWall(-10, H / 2, 20, H * 4);
  addFrameWall(WORLD.width + 10, H / 2, 20, H * 4);
  if (ceiling) addFrameWall(WORLD.width / 2, -10, WORLD.width * 2, 20);

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

    if (built.spin) {
      spinners.push({ body, spin: built.spin, pivot: { x: comp.x, y: comp.y }, angle: 0 });
    }
    if (built.hit) {
      reactive.set(body.id, {
        index: renderComponents.length,
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

  Matter.Composite.add(engine.world, bodies);

  return {
    board: {
      world: { width: WORLD.width, height: H },
      frame,
      components: renderComponents,
      goal: { x: WORLD.width / 2, y: goalY, width: 236 },
      ballRadius: BALL_RADIUS,
      mapName: mapDef.name,
    },
    spinners,
    reactive,
    height: H,
    goalY,
  };
}

/** 공 하나 생성 (공통 물리 속성) */
function createBall(x, y) {
  return Matter.Bodies.circle(x, y, BALL_RADIUS, {
    restitution: BALL_RESTITUTION,
    friction: 0.02,
    frictionAir: 0.008,
    density: 0.0015,
    collisionFilter: { category: CAT_BALL, mask: DEFAULT_MASK },
  });
}

module.exports = {
  buildBoard,
  createBall,
  CAT_WALL,
  CAT_PEG,
  CAT_BALL,
  DEFAULT_MASK,
  BALL_RADIUS,
  BALL_RESTITUTION,
};
