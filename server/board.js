/**
 * 맵 정의 → 물리 보드 생성 (라이브 게임과 이벤트 시뮬레이터가 공유)
 */

const Matter = require('matter-js');
const { WORLD, buildShapes, clampFinish, FINISH } = require('../public/components.js');

// 충돌 카테고리
const CAT_WALL = 0x0001; // 외벽 (유령 상태에서도 충돌)
const CAT_PEG = 0x0002; // 맵 구성요소 (유령 상태에서는 통과)
const CAT_BALL = 0x0004;
const DEFAULT_MASK = CAT_WALL | CAT_PEG | CAT_BALL;

const BALL_RADIUS = 7;
const BALL_RESTITUTION = 0.7;
const GOAL_MARGIN = 55; // 맵 바닥에서 이만큼 위가 골인선

/**
 * 엔진에 맵을 구성하고 렌더링 데이터를 반환한다.
 * @param {object} opts.ceiling  천장 생성 여부 (이벤트 모드는 공을 위로 쌓으므로 false)
 * @returns {{ board, spinners, reactive, height, goalY }}
 */
function buildBoard(engine, mapDef, { ceiling = true } = {}) {
  const H = Number(mapDef.height) || WORLD.height;
  // 🏁 골인 지점: 맵마다 위치·크기를 지정할 수 있다(없으면 바닥 중앙 기본값)
  const finish = clampFinish(mapDef.finish, H);
  const goalY = finish.y; // 도착선(존의 윗변)

  const bodies = [];
  const frame = [];
  const spinners = []; // { body, spin, pivot, angle }
  const movers = []; // { body, base, axis, range, speed } — 왕복 이동 벽
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
  // 바깥으로 두껍게(안쪽 면은 그대로 0 / width) — 빠른 공이 벽을 뚫고 나가는 터널링 방지
  addFrameWall(-30, H / 2, 60, H * 4);
  addFrameWall(WORLD.width + 30, H / 2, 60, H * 4);
  if (ceiling) addFrameWall(WORLD.width / 2, -30, WORLD.width * 2, 60);

  const renderComponents = [];

  // 가장자리 킥커: 양옆 벽을 타고 그냥 미끄러져 내려가지 못하도록
  // 일정 간격마다 안쪽으로 쳐내는 사선 벽을 모든 맵에 자동 배치한다.
  // 단, 맵이 이미 그 근처에 벽(통로·장벽)을 두고 있다면 설계를 존중해 건너뛴다.
  const mapWalls = (mapDef.components || []).filter((c) => c.type === 'wall');
  const nearWall = (x, y) =>
    mapWalls.some((w) => Math.abs(w.x - x) < 110 && Math.abs(w.y - y) < 300);
  const kickers = [];
  for (let y = 520; y < goalY - 380; y += 560) {
    if (!nearWall(32, y)) {
      kickers.push({ type: 'wall', x: 32, y, props: { length: 90, angle: 58 } });
    }
    const ry = y + 280;
    if (ry < goalY - 380 && !nearWall(WORLD.width - 32, ry)) {
      kickers.push({ type: 'wall', x: WORLD.width - 32, y: ry, props: { length: 90, angle: -58 } });
    }
  }
  const allComponents = [...(mapDef.components || []), ...kickers];
  for (const comp of allComponents) {
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
    if (built.move) {
      movers.push({
        body,
        base: { x: comp.x, y: comp.y },
        axis: built.move.axis === 'y' ? 'y' : 'x',
        range: built.move.range,
        speed: built.move.speed,
      });
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
      move: built.move || 0, // 클라이언트 애니메이션용 {axis,range,speed}
    });
  }

  Matter.Composite.add(engine.world, bodies);

  return {
    board: {
      world: { width: WORLD.width, height: H },
      frame,
      components: renderComponents,
      goal: { x: finish.x, y: finish.y, width: finish.width, height: finish.height },
      ballRadius: BALL_RADIUS,
      mapName: mapDef.name,
    },
    spinners,
    movers,
    reactive,
    height: H,
    goalY,
    finish,
  };
}

// ── 🏁 굴레 물리: 골인 통과 판정 + 바닥에 떨어지면 최상단에서 재시작 ──
// game.js(라이브)와 eventsim.js(이벤트)가 동일 로직을 공유한다.

/** 공이 이번 틱에 골인선을 (x 범위 안에서) 아래로 통과했는가 */
function crossedFinish(ball, finish) {
  const prevY = ball.plugin.prevY;
  if (prevY === undefined) return false;
  const half = finish.width / 2;
  return (
    prevY < finish.y &&
    ball.position.y >= finish.y &&
    ball.position.x >= finish.x - half &&
    ball.position.x <= finish.x + half
  );
}

/** 골인 못 하고 맵 바닥 밑으로 떨어진 공을 (x·속도 그대로) 최상단으로 되돌린다 */
function wrapIfFallen(ball, H) {
  if (ball.position.y <= H + 4) return false;
  // 속도는 유지, 가로 위치도 유지 → 그대로 이어서 최상단에서 다시 낙하
  Matter.Body.setPosition(ball, { x: ball.position.x, y: FINISH.topY });
  ball.plugin.prevY = FINISH.topY;
  if (ball.plugin.frozenPos) ball.plugin.frozenPos = { x: ball.position.x, y: FINISH.topY };
  return true;
}

/** 공 하나 생성 (공통 물리 속성) */
function createBall(x, y) {
  return Matter.Bodies.circle(x, y, BALL_RADIUS, {
    restitution: BALL_RESTITUTION,
    friction: 0.02,
    frictionAir: 0.004, // 낮을수록 최고 낙하 속도가 빨라짐
    density: 0.0015,
    collisionFilter: { category: CAT_BALL, mask: DEFAULT_MASK },
  });
}

module.exports = {
  buildBoard,
  createBall,
  crossedFinish,
  wrapIfFallen,
  CAT_WALL,
  CAT_PEG,
  CAT_BALL,
  DEFAULT_MASK,
  BALL_RADIUS,
  BALL_RESTITUTION,
};
