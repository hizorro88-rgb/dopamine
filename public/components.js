/**
 * 맵 구성요소 레지스트리 (서버/클라이언트 공용)
 * ─────────────────────────────────────────────
 * 새 구성요소를 추가하려면 아래 COMPONENTS 객체에 항목 하나만 추가하면 됩니다.
 * - 서버: 도형(shapes)을 그대로 물리 바디로 변환 (server/game.js가 자동 처리)
 * - 클라이언트: 도형을 그대로 캔버스에 렌더링 + 맵 에디터 팔레트에 자동 등록
 * → 서버/클라이언트 코드를 수정할 필요가 없습니다.
 *
 * 구성요소 스키마:
 *   id/name/emoji/desc : 에디터 팔레트에 표시
 *   props : 에디터에서 조절 가능한 속성 슬라이더 목록
 *           [{ key, label, min, max, step, default }]
 *   build(props) : 배치 지점(0,0) 기준의 상대 도형을 반환
 *     {
 *       shapes: [
 *         { kind:'circle', x, y, r, fill? } |
 *         { kind:'rect',   x, y, w, h, angle?, fill? }
 *       ],
 *       spin: 회전 속도 rad/s (0이면 고정, 0이 아니면 배치 지점을 축으로 회전),
 *       restitution: 반발력 (공이 튕기는 정도),
 *       hit: (선택) 공이 닿으면 발동하는 반응형 동작 데이터.
 *            server/game.js 의 HIT_ACTIONS[action] 이 실행한다.
 *            예: { action: 'explode', radius, power, respawnMs }
 *     }
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PinballComponents = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEG = Math.PI / 180;

  // 월드(보드) 크기 — 서버 물리와 클라이언트 렌더링/에디터가 공유
  // height 는 기본값이며, 맵마다 minHeight~maxHeight 범위에서 길이를 정할 수 있다
  const WORLD = { width: 600, height: 2400, minHeight: 900, maxHeight: 6000 };

  const COMPONENTS = {
    // 기본 핀
    peg: {
      id: 'peg',
      name: '핀',
      emoji: '📍',
      desc: '공이 튕기는 기본 핀',
      props: [{ key: 'size', label: '크기', min: 5, max: 16, step: 1, default: 8 }],
      build(p) {
        return {
          shapes: [{ kind: 'circle', x: 0, y: 0, r: p.size, fill: '#565a63' }],
          spin: 0,
          restitution: 0.5,
        };
      },
    },

    // 범퍼: 닿으면 강하게 튕겨나감
    bumper: {
      id: 'bumper',
      name: '범퍼',
      emoji: '🔴',
      desc: '닿으면 공이 강하게 튕겨나갑니다',
      props: [{ key: 'size', label: '크기', min: 14, max: 30, step: 1, default: 20 }],
      build(p) {
        return {
          shapes: [
            { kind: 'circle', x: 0, y: 0, r: p.size, fill: '#772833' },
            { kind: 'circle', x: 0, y: 0, r: p.size * 0.55, fill: '#a8404d' },
          ],
          spin: 0,
          restitution: 1.4,
        };
      },
    },

    // 고정 벽 (기울기 조절 가능)
    wall: {
      id: 'wall',
      name: '벽',
      emoji: '📏',
      desc: '공의 길을 막는 벽. 각도를 조절할 수 있어요',
      props: [
        { key: 'length', label: '길이', min: 40, max: 300, step: 10, default: 120 },
        { key: 'angle', label: '각도(°)', min: -90, max: 90, step: 5, default: 0 },
      ],
      build(p) {
        return {
          shapes: [
            { kind: 'rect', x: 0, y: 0, w: p.length, h: 14, angle: p.angle * DEG, fill: '#3a3c43' },
          ],
          spin: 0,
          restitution: 0.2,
        };
      },
    },

    // ★ 회전 막대: 뱅글뱅글 돌아가는 방해물
    spinner: {
      id: 'spinner',
      name: '회전 막대',
      emoji: '🌀',
      desc: '뱅글뱅글 돌아가며 공을 쳐내는 막대',
      props: [
        { key: 'length', label: '길이', min: 60, max: 260, step: 10, default: 150 },
        { key: 'speed', label: '회전 속도', min: -4, max: 4, step: 0.5, default: 2 },
      ],
      build(p) {
        return {
          shapes: [
            { kind: 'rect', x: 0, y: 0, w: p.length, h: 12, fill: '#6e3540' },
            { kind: 'circle', x: 0, y: 0, r: 9, fill: '#a8894a' },
          ],
          spin: p.speed,
          restitution: 0.8,
        };
      },
    },

    // 폭탄: 공이 닿으면 폭발 → 범위 안의 모든 공이 튕겨나감
    bomb: {
      id: 'bomb',
      name: '폭탄',
      emoji: '💣',
      desc: '공이 닿으면 펑! 폭발 범위 안의 모든 공이 튕겨나갑니다',
      props: [
        { key: 'radius', label: '폭발 범위', min: 80, max: 260, step: 10, default: 150 },
        { key: 'power', label: '폭발력', min: 6, max: 24, step: 1, default: 14 },
        { key: 'respawn', label: '재생성 시간(초)', min: 0, max: 15, step: 1, default: 6 },
      ],
      build(p) {
        return {
          shapes: [
            { kind: 'circle', x: 0, y: 0, r: 16, fill: '#232329' },
            { kind: 'circle', x: -5, y: -5, r: 5, fill: '#45454f' },
            { kind: 'rect', x: 10, y: -15, w: 12, h: 5, angle: -0.7, fill: '#8a6d4a' },
            { kind: 'circle', x: 14, y: -19, r: 4, fill: '#c98f33' },
          ],
          spin: 0,
          restitution: 0.3,
          hit: {
            action: 'explode',
            radius: p.radius,
            power: p.power,
            respawnMs: p.respawn * 1000, // 0이면 게임당 1회용
          },
        };
      },
    },

    // 회전 십자: 십자 모양 회전 방해물
    cross: {
      id: 'cross',
      name: '회전 십자',
      emoji: '➕',
      desc: '십자 모양으로 돌아가는 방해물',
      props: [
        { key: 'length', label: '길이', min: 60, max: 220, step: 10, default: 130 },
        { key: 'speed', label: '회전 속도', min: -4, max: 4, step: 0.5, default: -1.5 },
      ],
      build(p) {
        return {
          shapes: [
            { kind: 'rect', x: 0, y: 0, w: p.length, h: 12, fill: '#39584e' },
            { kind: 'rect', x: 0, y: 0, w: p.length, h: 12, angle: 90 * DEG, fill: '#39584e' },
            { kind: 'circle', x: 0, y: 0, r: 9, fill: '#a8894a' },
          ],
          spin: p.speed,
          restitution: 0.8,
        };
      },
    },
  };

  /** props 스키마의 기본값 객체 */
  function defaultProps(def) {
    const out = {};
    for (const p of def.props) out[p.key] = p.default;
    return out;
  }

  /** 구성요소 인스턴스의 도형 계산 (알 수 없는 타입이면 null) */
  function buildShapes(type, props) {
    const def = COMPONENTS[type];
    if (!def) return null;
    return def.build({ ...defaultProps(def), ...(props || {}) });
  }

  return { WORLD, COMPONENTS, defaultProps, buildShapes };
});
