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
  // width·height 는 기본값이며, 맵마다 min~max 범위에서 폭·길이를 정할 수 있다
  const WORLD = { width: 600, minWidth: 600, maxWidth: 2400, height: 4800, minHeight: 900, maxHeight: 12000 };
  /** 저장/전송된 맵 폭을 안전 범위(minWidth~maxWidth)로 정제 (없으면 기본 600) */
  function clampWidth(w) {
    const n = Math.round(Number(w));
    return Number.isFinite(n) ? Math.min(Math.max(n, WORLD.minWidth), WORLD.maxWidth) : WORLD.width;
  }

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
      const segLen = Math.hypot(dx, dy) + thick * 0.5 + 3; // 살짝 겹쳐 이음새 메움(얇아져도 물샐틈 없게)
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

  /**
   * 🍩 도넛(링) 벽을 원 둘레의 짧은 접선 사각형들로 근사한다.
   * gap>0 이면 그만큼(각도) 둘레를 비워 C자로 열린 링을 만든다.
   * @param {number} radius   링 반지름(중심선)
   * @param {number} thick    두께(px)
   * @param {string} fill      색
   * @param {number} gap       열림 각도(°) — 0이면 닫힌 도넛
   * @param {number} gapDir    열림이 향하는 방향(°) — 화면좌표(0=오른쪽,90=아래,270=위)
   */
  function ringShapes(radius, thick, fill, gap = 0, gapDir = 0) {
    const R = Math.max(12, radius);
    // 둘레 길이에 맞춰 조각 수 결정(촘촘할수록 매끈+빈틈 없음), 과도한 물리 파트 방지 위해 상한
    const segCount = Math.min(64, Math.max(16, Math.round((2 * Math.PI * R) / 16)));
    const gapRad = Math.max(0, gap) * DEG;
    const dir = gapDir * DEG;
    const shapes = [];
    // 원 위 연속한 두 점을 잇는 '현(chord)' 사각형으로 링을 만든다 — 이웃 조각이 꼭짓점을
    // 공유하므로 안쪽에 빈틈(V자 노치)이 생기지 않는다(curvedWallShapes 와 동일한 방식).
    for (let i = 0; i < segCount; i++) {
      const a1 = (i / segCount) * Math.PI * 2;
      const a2 = ((i + 1) / segCount) * Math.PI * 2;
      const mid = (a1 + a2) / 2;
      if (gapRad > 0) {
        // 열림 구간(방향 dir 중심 ±gap/2) 안의 조각은 건너뛴다
        const diff = Math.atan2(Math.sin(mid - dir), Math.cos(mid - dir)); // -π..π
        if (Math.abs(diff) < gapRad / 2) continue;
      }
      const x1 = Math.cos(a1) * R, y1 = Math.sin(a1) * R;
      const x2 = Math.cos(a2) * R, y2 = Math.sin(a2) * R;
      const dx = x2 - x1, dy = y2 - y1;
      shapes.push({
        kind: 'rect',
        x: (x1 + x2) / 2,
        y: (y1 + y2) / 2,
        w: Math.hypot(dx, dy) + thick * 0.5 + 2, // 꼭짓점에서 살짝 겹쳐 이음새 메움
        h: thick,
        angle: Math.atan2(dy, dx),
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
  function defaultFinish(H, W = WORLD.width) {
    return { x: W / 2, y: H - FINISH.margin, width: FINISH.defW, height: FINISH.defH };
  }
  /** 저장/전송된 finish 값을 맵 폭(W)·길이(H)에 맞게 안전 범위로 정제 */
  function clampFinish(f, H, W = WORLD.width) {
    const d = defaultFinish(H, W);
    if (!f || typeof f !== 'object') return d;
    const width = clampNum(f.width, FINISH.minW, W, d.width);
    const height = clampNum(f.height, FINISH.minH, FINISH.maxH, d.height);
    const x = clampNum(f.x, width / 2, W - width / 2, d.x);
    const y = clampNum(f.y, 220, H - 20, d.y);
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  /**
   * 💥 부딪히면 사라지는 벽의 현재 색 — 남은 횟수가 줄수록 시안→초록→노랑→주황→빨강으로
   * 달아오른다(곧 깨질 것 같은 느낌). 서버(초기 색 굽기)와 클라(피격 시 재색칠)가 공유해
   * 남은 횟수만 주고받아도 양쪽 색이 정확히 일치한다.
   */
  function breakWallColor(hitsLeft, total) {
    // 마지막 한 방 남았을 때 항상 빨강, 가득일 때 항상 시안 — total 과 무관하게 전 색상대를 사용
    const denom = Math.max(1, total - 1);
    const ratio = Math.max(0, Math.min(1, (hitsLeft - 1) / denom));
    const hue = Math.round(8 + ratio * 182); // 1남음=빨강(8) ~ 가득=시안(190)
    return `hsl(${hue}, 80%, 61%)`;
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
      desc: '공의 길을 막는 벽. 각도·곡률·"사라짐(부딪힘 횟수)"·점프력을 조절할 수 있어요',
      props: [
        { key: 'length', label: '길이', min: 40, max: 300, step: 10, default: 120 },
        { key: 'angle', label: '각도(°)', min: -180, max: 180, step: 1, default: 0 },
        { key: 'curve', label: '곡률(°)', min: -160, max: 160, step: 1, default: 0 },
        { key: 'breakHits', label: '사라짐(부딪힘 횟수, 0=안 사라짐)', min: 0, max: 50, step: 1, default: 0 },
        { key: 'bounce', label: '점프력(튕김, 0.7↑부터 강해짐)', min: 0, max: 2, step: 0.1, default: 0.2 },
      ],
      build(p) {
        // 두께 10px — 공 반지름(7)+벽 반두께(5) = 충돌 밴드 24px 로, 검사당 이동 상한(19px)보다
        // 넉넉히 커 얇아져도 공이 벽을 통과하지 않는다(실측 검증). 예전 14px 보다 날렵한 레일 느낌.
        // 💥 breakHits>0 이면 공이 N번 부딪히면 사라지는 벽 — 기본색을 흰색이 아닌
        //    달아오르는 색으로 굽고, hit 액션(vanish)을 달아 반응형으로 만든다.
        const hits = Math.round(p.breakHits || 0);
        const breakable = hits > 0;
        const fill = breakable ? breakWallColor(hits, hits) : '#e9edf4';
        const out = {
          shapes: curvedWallShapes(p.length, p.angle || 0, p.curve || 0, 10, fill),
          spin: 0,
          restitution: p.bounce != null ? p.bounce : 0.2, // 🦘 점프력(튕김)
        };
        if (breakable) out.hit = { action: 'vanish', hits, color: fill };
        return out;
      },
    },

    // 🍩 도넛(링) 벽: 동그란 링 모양 벽 — 공이 둘레에 튕긴다 (열림 각도로 C자도 가능)
    ring: {
      id: 'ring',
      name: '도넛 벽',
      emoji: '🍩',
      desc: '동그란 링(도넛) 모양의 벽. 반지름·두께·열림·"사라짐(부딪힘 횟수)"·점프력을 조절할 수 있어요',
      props: [
        { key: 'radius', label: '반지름', min: 30, max: 220, step: 1, default: 90 },
        { key: 'thickness', label: '두께', min: 6, max: 22, step: 1, default: 10 },
        { key: 'gap', label: '열림(각도°, 0=닫힘)', min: 0, max: 300, step: 5, default: 0 },
        // 열림 방향: 화면좌표(0=오른쪽,90=아래,180=왼쪽,270=위). 기본은 아래(=∩ 아치)라
        // 무심코 열어도 공을 가두는 위쪽 그릇(바가지)이 되지 않는다.
        { key: 'gapDir', label: '열림 방향(°, 90=아래·270=위)', min: 0, max: 359, step: 1, default: 90 },
        { key: 'breakHits', label: '사라짐(부딪힘 횟수, 0=안 사라짐)', min: 0, max: 50, step: 1, default: 0 },
        { key: 'bounce', label: '점프력(튕김, 0.7↑부터 강해짐)', min: 0, max: 2, step: 0.1, default: 0.2 },
      ],
      build(p) {
        // 💥 벽과 동일한 '사라짐' 옵션 — breakHits>0 이면 N번 부딪히면 사라지는 도넛(색이 달아오름)
        const hits = Math.round(p.breakHits || 0);
        const breakable = hits > 0;
        const fill = breakable ? breakWallColor(hits, hits) : '#e9edf4';
        const out = {
          shapes: ringShapes(p.radius, p.thickness, fill, p.gap || 0, p.gapDir || 0),
          spin: 0,
          restitution: p.bounce != null ? p.bounce : 0.2, // 🦘 점프력(튕김)
        };
        if (breakable) out.hit = { action: 'vanish', hits, color: fill };
        return out;
      },
    },

    // 🌈 무지개: 7색 동심 반원 아치(반 도넛). 방향(아래∩·왼쪽·오른쪽·위)을 바꿀 수 있다.
    rainbow: {
      id: 'rainbow',
      name: '무지개',
      emoji: '🌈',
      desc: '7색 반 도넛 무지개 아치. 크기·방향(아래∩·왼쪽·오른쪽·위)·색 띠 두께·점프력을 조절해요',
      props: [
        { key: 'radius', label: '반지름(바깥)', min: 45, max: 200, step: 1, default: 110 },
        { key: 'band', label: '색 띠 두께', min: 5, max: 12, step: 1, default: 8 },
        { key: 'dir', label: '방향(0=아래∩,1=왼쪽,2=오른쪽,3=위∪)', min: 0, max: 3, step: 1, default: 0 },
        { key: 'bounce', label: '점프력(튕김, 0.7↑부터 강해짐)', min: 0, max: 2, step: 0.1, default: 0.3 },
      ],
      build(p) {
        // 무지개 7색(빨주노초파남보): 바깥이 빨강, 안쪽이 보라
        const colors = ['#ff4d4d', '#ff9d2e', '#ffe14a', '#4ade5a', '#35b6ff', '#4b6bff', '#a45cff'];
        // 방향 → '열림(제거)' 방향. 화면좌표(0=오른쪽,90=아래,180=왼쪽,270=위)
        //  0 아래로 열림(∩ 위 반원)=90 · 1 왼쪽으로 열림())=180 · 2 오른쪽으로 열림(()=0 · 3 위로 열림(∪)=270
        const gapDir = [90, 180, 0, 270][Math.round(p.dir) || 0] ?? 90;
        const band = p.band || 8;
        const shapes = [];
        // ── 장식 아치(물리 없음): 꽉 찬 반원 벽처럼 보이는 7색 무지개 ──
        //    닫힌/두꺼운 아치는 공을 정수리에 얹어 가두기 쉬우므로 '보이기'만 하고 통과시킨다.
        let inner = p.radius;
        for (let i = 0; i < colors.length; i++) {
          const r = p.radius - i * band;
          if (r < band + 4) break;
          inner = r;
          for (const s of ringShapes(r, band, colors[i], 180, gapDir)) shapes.push({ ...s, noPhysics: true });
        }
        // ── 물리 도트: 아치 바깥 테두리를 따라 성기게 박은 작은 공 — 공이 튕기되
        //    도트 사이 틈으로 새어 빠지므로 절대 가두지 않는다(픽셀아트 맵과 같은 원리).
        const rDot = p.radius - band / 2; // 바깥(빨강) 테두리
        const solid = (((gapDir + 180) % 360) * Math.PI) / 180; // 반원(벽)의 중심 방향
        const nDots = Math.max(6, Math.round((Math.PI * rDot) / 30));
        for (let k = 0; k <= nDots; k++) {
          const a = solid - Math.PI / 2 + Math.PI * (k / nDots);
          shapes.push({ kind: 'circle', x: Math.cos(a) * rDot, y: Math.sin(a) * rDot, r: 6, fill: colors[0], glow: colors[0] });
        }
        return { shapes, spin: 0, restitution: p.bounce != null ? p.bounce : 0.3 };
      },
    },

    // ↔️ 움직이는 벽: 좌우(또는 위아래)로 왕복하는 벽 — 타이밍을 맞춰 통과
    movewall: {
      id: 'movewall',
      name: '움직이는 벽',
      emoji: '↔️',
      desc: '좌우(또는 위아래)로 왕복하며 움직이는 벽. 타이밍을 맞춰 통과하세요!',
      props: [
        { key: 'length', label: '길이', min: 40, max: 260, step: 10, default: 120 },
        { key: 'angle', label: '각도(°)', min: -90, max: 90, step: 1, default: 0 },
        { key: 'range', label: '이동 거리', min: 30, max: 240, step: 10, default: 120 },
        { key: 'movespeed', label: '이동 속도', min: 0.5, max: 4, step: 0.5, default: 1.5 },
        { key: 'phase', label: '시작 위치(위상 °)', min: 0, max: 360, step: 1, default: 0 },
        { key: 'vertical', label: '세로 이동(0=좌우,1=위아래)', min: 0, max: 1, step: 1, default: 0 },
      ],
      build(p) {
        return {
          shapes: [
            { kind: 'rect', x: 0, y: 0, w: p.length, h: 10, angle: (p.angle || 0) * DEG, fill: '#b48ce8' },
            { kind: 'rect', x: 0, y: 0, w: p.length * 0.5, h: 3, angle: (p.angle || 0) * DEG, fill: '#e8d6ff' },
          ],
          spin: 0,
          restitution: 0.3,
          // phase(위상)로 시작 위치를 어긋나게 해 벽마다 다른 타이밍으로 움직이게 한다
          move: { axis: p.vertical ? 'y' : 'x', range: p.range, speed: p.movespeed, phase: (p.phase || 0) * DEG },
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

    // 🎁 아이템 상자: 공이 닿으면 무작위 아이템 효과를 그 공이 획득 (로켓·유령·자석·번개·충격파)
    itembox: {
      id: 'itembox',
      name: '아이템 상자',
      emoji: '🎁',
      desc: '공이 닿으면 무작위 아이템(로켓·유령·자석·번개·충격파)을 그 공이 획득해요!',
      props: [
        { key: 'respawn', label: '재생성 시간(초)', min: 0, max: 15, step: 1, default: 5 },
      ],
      build(p) {
        return {
          shapes: [
            { kind: 'rect', x: 0, y: 0, w: 30, h: 30, angle: 0, fill: '#d4af37', glow: '#ffe14a' },
            { kind: 'rect', x: 0, y: 0, w: 30, h: 7, angle: 0, fill: '#fff3b0' },
            { kind: 'rect', x: 0, y: 0, w: 7, h: 30, angle: 0, fill: '#fff3b0' },
            { kind: 'rect', x: 0, y: 0, w: 13, h: 13, angle: 0.785, fill: '#35e0ff' },
          ],
          spin: 0,
          restitution: 0.2,
          hit: {
            action: 'powerup',
            respawnMs: p.respawn * 1000, // 0이면 게임당 1회
          },
        };
      },
    },

    // 🕳️ 포탈: 같은 채널의 다른 포탈로 순간이동 — 경로가 비선형이 된다
    portal: {
      id: 'portal',
      name: '포탈',
      emoji: '🕳️',
      desc: '닿으면 같은 채널의 다른 포탈로 순간이동! 두 개씩 짝지어 배치하세요',
      props: [
        { key: 'channel', label: '채널 (같은 번호끼리 연결)', min: 1, max: 4, step: 1, default: 1 },
      ],
      build(p) {
        const colors = ['#35e0ff', '#c86bff', '#ffd12e', '#9bec00'];
        const c = colors[(Math.round(p.channel) - 1 + 400) % 4];
        // 동심원(빛나는 고리 여러 겹) → 빨려드는 '워프' 느낌
        return {
          shapes: [
            { kind: 'circle', x: 0, y: 0, r: 24, fill: c },
            { kind: 'circle', x: 0, y: 0, r: 18, fill: '#0a0a10', glow: c },
            { kind: 'circle', x: 0, y: 0, r: 12, fill: c },
            { kind: 'circle', x: 0, y: 0, r: 6, fill: '#0a0a10', glow: c },
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
        { key: 'angle', label: '발사 각도(°)', min: -90, max: 90, step: 1, default: 0 },
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

  // ── 🎁 개별 아이템 요소: 폭탄처럼 맵에 배치. 공이 닿으면 그 아이템 효과가 발동한다 ──
  //   버프(자기 공 강화)와 함정(닿은 공에 방해 효과)이 섞여 맵 설계에 다양성을 준다.
  //   실제 효과 로직은 server/items.js (game.js HIT_ACTIONS.item 이 itemId 로 실행).
  const PLACEABLE_ITEMS = [
    { id: 'ghost', name: '유령 낙하', emoji: '👻', color: '#e2e8ff' },
    { id: 'freeze', name: '얼리기(함정)', emoji: '🧊', color: '#7fdfff' },
    { id: 'magnet', name: '자석', emoji: '🧲', color: '#ff6b6b' },
    { id: 'lightning', name: '번개', emoji: '⚡', color: '#ffe14a' },
    { id: 'rocket', name: '로켓 부스트', emoji: '🚀', color: '#ff8a3d' },
    { id: 'shockwave', name: '충격파', emoji: '💥', color: '#ffb03a' },
    { id: 'gust', name: '돌풍(함정)', emoji: '🌪️', color: '#8fe0d0' },
    { id: 'morph', name: '변신(함정)', emoji: '🎭', color: '#c8a6ff' },
    { id: 'balloon', name: '풍선(함정)', emoji: '🎈', color: '#ff9ecb' },
    { id: 'timestop', name: '시간 정지', emoji: '⏸️', color: '#a0c4ff' },
    { id: 'clone', name: '분신', emoji: '✨', color: '#ffd76a' },
    { id: 'karma', name: '저주(함정)', emoji: '🎡', color: '#b48ce8' },
  ];
  for (const it of PLACEABLE_ITEMS) {
    COMPONENTS['item_' + it.id] = {
      id: 'item_' + it.id,
      name: it.name,
      emoji: it.emoji,
      desc: `공이 닿으면 그 공이 '${it.name}' 효과를 얻습니다 (폭탄처럼 소비 후 재생성).`,
      props: [{ key: 'respawn', label: '재생성 시간(초)', min: 0, max: 15, step: 1, default: 5 }],
      build(p) {
        return {
          shapes: [
            { kind: 'rect', x: 0, y: 0, w: 30, h: 30, angle: 0, fill: '#15151d', glow: it.color },
            { kind: 'text', x: 0, y: 0, text: it.emoji, size: 20, glow: it.color },
          ],
          spin: 0,
          restitution: 0.2,
          hit: { action: 'item', itemId: it.id, respawnMs: p.respawn * 1000 },
        };
      },
    };
  }

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
    clampWidth,
    curvedWallShapes,
    breakWallColor,
  };
});
