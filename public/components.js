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
  const WORLD = { width: 600, height: 4800, minHeight: 900, maxHeight: 12000 };

  /**
   * 곡선(호) 벽을 작은 사각형 조각들로 근사한다.
   * curve=0 이면 기존과 동일한 직선 사각형 1개를 반환(하위 호환·성능).
   * @param {number} length 벽 전체 길이(호 길이)
   * @param {number} angle  전체 기울기(°)
   * @param {number} curve  휘어짐(°) — 양수/음수로 휘는 방향이 바뀜
   * @param {number} thick  두께(px)
   */
  function curvedWallShapes(length, angle, curve, thick, fill) {
    const a0 = angle * DEG;
    // 직선: 조각 1개 (기존 동작 유지)
    if (Math.abs(curve) < 1) {
      return [{ kind: 'rect', x: 0, y: 0, w: length, h: thick, angle: a0, fill }];
    }
    const sweep = curve * DEG; // 전체 호가 도는 각
    const R = length / Math.abs(sweep); // 호 길이 = R * |sweep|
    const segCount = Math.min(14, Math.max(4, Math.round(length / 24)));
    // 원점을 기준으로 호를 그리고(중앙이 원점에 오도록 보정), 마지막에 angle 만큼 회전
    const pts = [];
    for (let i = 0; i <= segCount; i++) {
      const t = i / segCount - 0.5; // -0.5 ~ 0.5
      const ang = sweep * t;
      // 호를 x축 진행 + y축으로 휘게: (R*sin, R*(1-cos)*sign)
      pts.push({ x: R * Math.sin(ang), y: R * (1 - Math.cos(ang)) * Math.sign(sweep) });
    }
    // 중앙(첫·끝 중점)이 원점에 오도록 평행이동
    const cx = (pts[0].x + pts[segCount].x) / 2;
    const cy = (pts[0].y + pts[segCount].y) / 2;
    const cos = Math.cos(a0);
    const sin = Math.sin(a0);
    const shapes = [];
    for (let i = 0; i < segCount; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const mx = (p1.x + p2.x) / 2 - cx;
      const my = (p1.y + p2.y) / 2 - cy;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const segLen = Math.hypot(dx, dy) + thick * 0.5; // 살짝 겹쳐 이음새 메움
      const segAng = Math.atan2(dy, dx);
      // angle(a0) 회전 적용
      shapes.push({
        kind: 'rect',
        x: mx * cos - my * sin,
        y: mx * sin + my * cos,
        w: segLen,
        h: thick,
        angle: segAng + a0,
        fill,
      });
    }
    return shapes;
  }

  // ── 🏁 골인(FINISH) 지오메트리 — 위치·크기를 맵마다 지정 가능 ──
  // 서버 물리(도착 판정)와 클라이언트 렌더/에디터가 공유한다.
  const FINISH = {
    minW: 70, maxW: WORLD.width, defW: 236,
    minH: 24, maxH: 260, defH: 46,
    margin: 55, // 기본 위치: 맵 바닥에서 이만큼 위
    topY: 26, // 굴레: 바닥까지 떨어진 공이 다시 시작하는 최상단 y
  };
  function clampNum(v, min, max, dflt) {
    v = Number(v);
    return Number.isFinite(v) ? Math.min(Math.max(v, min), max) : dflt;
  }
  function defaultFinish(H) {
    return { x: WORLD.width / 2, y: H - FINISH.margin, width: FINISH.defW, height: FINISH.defH };
  }
  /** 저장/전송된 finish 값을 맵 길이(H)에 맞게 안전 범위로 정제 */
  function clampFinish(f, H) {
    const d = defaultFinish(H);
    if (!f || typeof f !== 'object') return d;
    const width = clampNum(f.width, FINISH.minW, FINISH.maxW, d.width);
    const height = clampNum(f.height, FINISH.minH, FINISH.maxH, d.height);
    const x = clampNum(f.x, width / 2, WORLD.width - width / 2, d.x);
    const y = clampNum(f.y, 220, H - 20, d.y);
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

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
          shapes: [{ kind: 'circle', x: 0, y: 0, r: p.size, fill: '#35e0ff' }],
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
            { kind: 'circle', x: 0, y: 0, r: p.size, fill: '#ffd12e' },
            { kind: 'circle', x: 0, y: 0, r: p.size * 0.55, fill: '#fff3b0' },
          ],
          spin: 0,
          restitution: 1.4,
        };
      },
    },

    // 고정 벽 (기울기 + 곡률 조절 가능)
    wall: {
      id: 'wall',
      name: '벽',
      emoji: '📏',
      desc: '공의 길을 막는 벽. 각도와 곡률(휘어짐)을 조절할 수 있어요',
      props: [
        { key: 'length', label: '길이', min: 40, max: 300, step: 10, default: 120 },
        { key: 'angle', label: '각도(°)', min: -90, max: 90, step: 5, default: 0 },
        { key: 'curve', label: '곡률(°)', min: -160, max: 160, step: 10, default: 0 },
      ],
      build(p) {
        return {
          shapes: curvedWallShapes(p.length, p.angle || 0, p.curve || 0, 14, '#e9edf4'),
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
      desc: '뱅글뱅글 돌아가며 공을 쳐내는 막대 (속도 +는 시계방향, −는 반시계방향)',
      props: [
        { key: 'length', label: '길이', min: 60, max: 260, step: 10, default: 150 },
        { key: 'speed', label: '회전 속도(±방향)', min: -9, max: 9, step: 0.5, default: 4 },
      ],
      build(p) {
        return {
          shapes: [
            { kind: 'rect', x: 0, y: 0, w: p.length, h: 12, fill: '#35e0ff' },
            { kind: 'circle', x: 0, y: 0, r: 9, fill: '#f2f5fa' },
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
            { kind: 'circle', x: 0, y: 0, r: 16, fill: '#16161b', glow: '#ff5c47' },
            { kind: 'circle', x: -5, y: -5, r: 5, fill: '#33333d' },
            { kind: 'rect', x: 10, y: -15, w: 12, h: 5, angle: -0.7, fill: '#8a6d4a' },
            { kind: 'circle', x: 14, y: -19, r: 4, fill: '#ff6868' },
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

    // 🌀 포탈: 같은 채널의 다른 포탈로 순간이동 — 경로가 비선형이 된다
    portal: {
      id: 'portal',
      name: '포탈',
      emoji: '🌀',
      desc: '닿으면 같은 채널의 다른 포탈로 순간이동! 두 개씩 짝지어 배치하세요',
      props: [
        { key: 'channel', label: '채널 (같은 번호끼리 연결)', min: 1, max: 4, step: 1, default: 1 },
      ],
      build(p) {
        const colors = ['#35e0ff', '#c86bff', '#ffd12e', '#9bec00'];
        const c = colors[(Math.round(p.channel) - 1 + 400) % 4];
        return {
          shapes: [
            { kind: 'circle', x: 0, y: 0, r: 24, fill: c },
            { kind: 'circle', x: 0, y: 0, r: 16, fill: '#0a0a10', glow: c },
          ],
          spin: 0,
          restitution: 0,
          hit: { action: 'teleport', channel: Math.round(p.channel) },
        };
      },
    },

    // 🦘 점프 패드: 밟으면 공을 위로 쏘아 올린다 — 낙하가 역류한다
    jumper: {
      id: 'jumper',
      name: '점프 패드',
      emoji: '🦘',
      desc: '공이 닿으면 위로 강하게 쏘아 올립니다 (각도로 방향 조절)',
      props: [
        { key: 'width', label: '폭', min: 50, max: 160, step: 10, default: 90 },
        { key: 'power', label: '점프력', min: 8, max: 24, step: 1, default: 15 },
        { key: 'angle', label: '발사 각도(°)', min: -90, max: 90, step: 5, default: 0 },
      ],
      build(p) {
        return {
          shapes: [
            { kind: 'rect', x: 0, y: 0, w: p.width, h: 12, angle: (p.angle / 2) * DEG, fill: '#ff9d2e' },
            { kind: 'rect', x: 0, y: -8, w: p.width * 0.5, h: 5, angle: (p.angle / 2) * DEG, fill: '#ffd94a' },
          ],
          spin: 0,
          restitution: 0.2,
          hit: {
            action: 'launch',
            power: p.power,
            kickX: Math.round(Math.sin(p.angle * DEG) * p.power * 10) / 10,
          },
        };
      },
    },

    // 회전 십자: 십자 모양 회전 방해물
    cross: {
      id: 'cross',
      name: '회전 십자',
      emoji: '➕',
      desc: '십자 모양으로 돌아가는 방해물 (속도 +는 시계방향, −는 반시계방향)',
      props: [
        { key: 'length', label: '길이', min: 60, max: 220, step: 10, default: 130 },
        { key: 'speed', label: '회전 속도(±방향)', min: -9, max: 9, step: 0.5, default: -3.5 },
      ],
      build(p) {
        return {
          shapes: [
            { kind: 'rect', x: 0, y: 0, w: p.length, h: 12, fill: '#9bec00' },
            { kind: 'rect', x: 0, y: 0, w: p.length, h: 12, angle: 90 * DEG, fill: '#9bec00' },
            { kind: 'circle', x: 0, y: 0, r: 9, fill: '#f2f5fa' },
          ],
          spin: p.speed,
          restitution: 0.8,
        };
      },
    },
  };

  /** 레지스트리 안전 조회: 프로토타입 키(__proto__/constructor 등)를 걸러 실제 정의만 반환 */
  function lookupComponent(type) {
    return Object.prototype.hasOwnProperty.call(COMPONENTS, type) ? COMPONENTS[type] : null;
  }

  /** props 스키마의 기본값 객체 */
  function defaultProps(def) {
    const out = {};
    for (const p of def.props) out[p.key] = p.default;
    return out;
  }

  /** 구성요소 인스턴스의 도형 계산 (알 수 없는 타입이면 null) */
  function buildShapes(type, props) {
    const def = lookupComponent(type);
    if (!def) return null;
    return def.build({ ...defaultProps(def), ...(props || {}) });
  }

  return {
    WORLD,
    COMPONENTS,
    defaultProps,
    buildShapes,
    lookupComponent,
    FINISH,
    defaultFinish,
    clampFinish,
    curvedWallShapes,
  };
});
