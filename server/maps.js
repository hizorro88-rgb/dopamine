/**
 * 맵 저장소: 기본 제공 맵 + 유저 제작 맵 (data/maps.json 에 영구 저장)
 * 유저가 에디터에서 저장한 맵은 서버의 모든 방에서 선택할 수 있다.
 */

const fs = require('fs');
const path = require('path');
const { WORLD, COMPONENTS, defaultProps, lookupComponent, clampFinish, clampWidth } = require('../public/components.js');
const { atomicWriteJSON } = require('./security');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'maps.json');
const OVERRIDE_FILE = path.join(DATA_DIR, 'map-overrides.json'); // 기본 맵 편집본

// 에디터에서 배치 가능한 영역 (위: 공 시작 구역 / 아래: 골인 구역 제외)
// maxY 는 맵 길이에 따라 달라짐: height - 100
const settings = require('./settings'); // 하루 맵 생성 제한을 live 로 읽는다 (관리자 페이지에서 변경 가능)

const BOUNDS = { minX: 25, maxX: 575, minY: 130 };
const MAX_COMPONENTS = 400;
const MAX_COMPONENTS_ADMIN = 2000; // 관리자 편집은 상한 넉넉히 (기본 맵은 600+ 구성요소도 있음)
const MAX_CUSTOM_MAPS = 200;

/** 서버 로컬 기준 YYYY-MM-DD */
function localDate() {
  return new Date().toLocaleDateString('sv-SE');
}

// ── 기본 맵 ──────────────────────────────────────────────

function peg(x, y, size = 8) {
  return { type: 'peg', x, y, props: { size } };
}

// 맵 하단 공통: 골인 지점으로 좁아지는 깔때기
function funnel(H = WORLD.height) {
  return [
    { type: 'wall', x: 115, y: H - 155, props: { length: 290, angle: 27.5 } },
    { type: 'wall', x: 485, y: H - 155, props: { length: 290, angle: -27.5 } },
    { type: 'wall', x: 232, y: H - 65, props: { length: 70, angle: 90 } },
    { type: 'wall', x: 368, y: H - 65, props: { length: 70, angle: 90 } },
  ];
}

function pegRow(comps, y, offset = 0) {
  for (let x = 84 + offset; x <= 516; x += 54) comps.push(peg(x, y));
}

/**
 * 촘촘한 육각 핀 밭 — 빈 구간을 잔잔한 핀으로 채워 수많은 잔충돌로 낙하를 늦춘다.
 * 낱개 핀이라 절대 공을 가두지 않는다(클래식 맵과 동일 원리). 짧은 맵의 체류시간을
 * 안전하게 늘리는 용도. rows 줄, vgap 간격, gap 가로간격으로 밀도 조절.
 */
function pegField(comps, y0, rows, { size = 6, gap = 54, vgap = 46, x0 = 70, x1 = 530 } = {}) {
  for (let r = 0; r < rows; r++) {
    const y = y0 + r * vgap;
    const off = r % 2 === 0 ? 0 : Math.round(gap / 2);
    for (let x = x0 + off; x <= x1; x += gap) comps.push(peg(x, y, size));
  }
}

function classicComponents() {
  const comps = [];
  let row = 0;
  for (let y = 170; y <= WORLD.height - 260; y += 62) {
    const offset = row % 2 === 0 ? 0 : 29;
    for (let x = 55 + offset; x <= 545; x += 58) comps.push(peg(x, y));
    row++;
  }
  regroupGate(comps, Math.round(WORLD.height * 0.36));
  regroupGate(comps, Math.round(WORLD.height * 0.68));
  return [...comps, ...funnel()];
}

function spinnerParkComponents() {
  const comps = [];

  // 1구간: 핀 + 범퍼 삼각
  pegRow(comps, 170);
  pegRow(comps, 222, 27);
  comps.push({ type: 'bumper', x: 300, y: 320, props: { size: 24 } });
  comps.push({ type: 'bumper', x: 110, y: 385, props: { size: 18 } });
  comps.push({ type: 'bumper', x: 490, y: 385, props: { size: 18 } });

  // 2구간: 회전 막대 쌍 + 중앙 십자 + 구석 폭탄
  comps.push({ type: 'spinner', x: 170, y: 530, props: { length: 160, speed: 4 } });
  comps.push({ type: 'spinner', x: 430, y: 530, props: { length: 160, speed: -4 } });
  comps.push({ type: 'cross', x: 300, y: 690, props: { length: 150, speed: 3 } });
  comps.push({ type: 'bomb', x: 60, y: 690, props: { radius: 150, power: 14, respawn: 6 } });
  comps.push({ type: 'bomb', x: 540, y: 690, props: { radius: 150, power: 14, respawn: 6 } });

  // 3구간: 핀 + 가운데로 모으는 경사벽
  pegRow(comps, 830);
  pegRow(comps, 882, 27);
  comps.push({ type: 'wall', x: 120, y: 1000, props: { length: 200, angle: 35 } });
  comps.push({ type: 'wall', x: 480, y: 1000, props: { length: 200, angle: -35 } });
  comps.push({ type: 'bumper', x: 300, y: 1020, props: { size: 20 } });

  // 4구간: 대형 중앙 회전 막대 + 사이드 범퍼
  comps.push({ type: 'spinner', x: 300, y: 1170, props: { length: 220, speed: 5 } });
  comps.push({ type: 'bumper', x: 85, y: 1170, props: { size: 16 } });
  comps.push({ type: 'bumper', x: 515, y: 1170, props: { size: 16 } });

  // 5구간: 회전 십자 쌍
  comps.push({ type: 'cross', x: 170, y: 1350, props: { length: 130, speed: -4 } });
  comps.push({ type: 'cross', x: 430, y: 1350, props: { length: 130, speed: 4 } });

  // 6구간: 핀 + 지그재그 벽
  pegRow(comps, 1490);
  pegRow(comps, 1542, 27);
  comps.push({ type: 'wall', x: 180, y: 1670, props: { length: 280, angle: 20 } });
  comps.push({ type: 'wall', x: 420, y: 1820, props: { length: 280, angle: -20 } });

  // 7구간: 마지막 관문 — 빠른 회전 막대 + 중앙 폭탄
  comps.push({ type: 'spinner', x: 150, y: 1975, props: { length: 150, speed: -6 } });
  comps.push({ type: 'spinner', x: 450, y: 1975, props: { length: 150, speed: 6 } });
  comps.push({ type: 'bomb', x: 300, y: 2080, props: { radius: 180, power: 16, respawn: 5 } });
  pegRow(comps, 2170);

  const gates = [];
  regroupGate(gates, 1728);
  regroupGate(gates, 3264);
  return [...gates, ...tileY(comps, 2, 2250), ...funnel()];
}

// ── 픽셀 아트 헬퍼: 미니맵에서 그림이 보이는 맵을 만들기 위한 도구 ──
// 전부 "점선"으로 그린다 — 점 사이 틈으로 공이 새어 나가므로 그림이 공을 가두지 않는다.

/** 원(호) 위에 핀을 점점이 배치. a0~a1은 도(°) 단위, 시계 12시가 -90 */
function arcDots(comps, cx, cy, r, a0, a1, n, size = 7) {
  for (let i = 0; i < n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / Math.max(n - 1, 1)) * Math.PI) / 180;
    comps.push(peg(cx + Math.cos(a) * r, cy + Math.sin(a) * r, size));
  }
}
function ringDots(comps, cx, cy, r, n, size = 7) {
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    comps.push(peg(cx + Math.cos(a) * r, cy + Math.sin(a) * r, size));
  }
}
/** 두 점 사이를 핀 점선으로 연결 */
function lineDots(comps, x1, y1, x2, y2, step = 34, size = 7) {
  const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / step));
  for (let i = 0; i <= n; i++) {
    comps.push(peg(x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n, size));
  }
}
/**
 * 문자 그리드 → 구성요소 (도트 그림용)
 *   o 핀 / O 큰 핀 / * 범퍼(노랑) / @ 폭탄(붉은 글로우) / . 빈칸
 */
function pixelGrid(comps, art, { y0, cell = 34, x0 = null, pegSize = 7 } = {}) {
  const cols = Math.max(...art.map((r) => r.length));
  const startX = x0 !== null ? x0 : (WORLD.width - (cols - 1) * cell) / 2;
  art.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      const x = startX + c * cell;
      const y = y0 + r * cell;
      if (ch === 'o') comps.push(peg(x, y, pegSize));
      else if (ch === 'O') comps.push(peg(x, y, 11));
      else if (ch === '*') comps.push({ type: 'bumper', x, y, props: { size: 15 } });
      else if (ch === '@')
        comps.push({ type: 'bomb', x, y, props: { radius: 130, power: 13, respawn: 8 } });
    });
  });
}

/** 꺾은선 경로 → 이어진 벽 조각들 (조각당 최대 280) — 협곡·코스형 맵용 */
function wallPath(comps, points) {
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const total = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(1, Math.ceil(total / 280));
    for (let s = 0; s < n; s++) {
      const ax = x1 + ((x2 - x1) * s) / n;
      const ay = y1 + ((y2 - y1) * s) / n;
      const bx = x1 + ((x2 - x1) * (s + 1)) / n;
      const by = y1 + ((y2 - y1) * (s + 1)) / n;
      let ang = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
      if (ang > 90) ang -= 180;
      if (ang < -90) ang += 180;
      comps.push({
        type: 'wall',
        x: Math.round((ax + bx) / 2),
        y: Math.round((ay + by) / 2),
        props: {
          length: Math.round(Math.hypot(bx - ax, by - ay)) + 6, // 이음새가 벌어지지 않게 살짝 겹침
          angle: Math.round(ang * 10) / 10,
        },
      });
    }
  }
}

// 🐍 지그재그 협곡: 좌우로 꺾이는 벽 코스 — 공이 직선으로 못 떨어진다
function canyonComponents() {
  const comps = [];
  // 1굽이: 왼쪽 벽 → 오른쪽 통로만 열림
  wallPath(comps, [[25, 320], [430, 560]]);
  // 통로 안 핀 3개
  lineDots(comps, 480, 430, 520, 530, 45, 6);
  // 2굽이: 오른쪽 벽 → 왼쪽으로
  wallPath(comps, [[575, 700], [170, 950]]);
  comps.push({ type: 'bumper', x: 100, y: 860, props: { size: 15 } });
  // 3굽이: 왼쪽 벽 → 오른쪽으로
  wallPath(comps, [[25, 1090], [430, 1340]]);
  comps.push({ type: 'bomb', x: 520, y: 1220, props: { radius: 130, power: 13, respawn: 7 } });
  // 삼각 섬: 꼭짓점이 위라 물길이 양쪽으로 갈라진다 (첨부 그림의 삼각형)
  wallPath(comps, [[300, 1500], [215, 1665], [385, 1665], [300, 1500]]);
  comps.push({ type: 'cross', x: 300, y: 1810, props: { length: 100, speed: 4 } });
  // 4굽이: 오른쪽 벽 → 왼쪽으로
  wallPath(comps, [[575, 1900], [170, 2150]]);
  // 빗금 밭: 짧은 사선 벽 격자 (첨부 그림의 빗금 구간)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 7; c++) {
      comps.push({
        type: 'wall',
        x: 90 + c * 70 + (r % 2) * 35,
        y: 2300 + r * 85,
        props: { length: 46, angle: 42 },
      });
    }
  }
  // 🪨 돌부리(pebbles): 빗금 밭과 지그재그 바 사이 평평한 구간에 잔돌 핀을 깔아 지체시킨다.
  pegField(comps, 2540, 2, { size: 6, gap: 56 });
  // 지그재그 바: /\/\ — 골짜기마다 30px 배수 틈을 둬서 공이 고이지 않는다
  for (let i = 0; i < 3; i++) {
    const x0 = 55 + i * 185;
    wallPath(comps, [[x0, 2720], [x0 + 70, 2630]]);
    wallPath(comps, [[x0 + 85, 2630], [x0 + 155, 2720]]);
  }
  // 마지막 스피너 관문
  comps.push({ type: 'spinner', x: 300, y: 2880, props: { length: 190, speed: 5 } });
  const gates = [];
  regroupGate(gates, 1408);
  regroupGate(gates, 2560);
  regroupGate(gates, 3712);
  regroupGate(gates, 4864);
  return [...gates, ...tileY(comps, 2, 3000), ...funnel(6400)];
}

// 🌪 깔때기 폭포: 구멍 위치가 번갈아 바뀌는 깔때기 연속 — 병목에서 순위가 뒤집힌다
function cascadeComponents() {
  const comps = [];
  const funnels = [
    { y: 420, hole: 300 }, // 가운데
    { y: 850, hole: 120 }, // 왼쪽
    { y: 1280, hole: 480 }, // 오른쪽
    { y: 1710, hole: 220 }, // 중간 왼쪽
    { y: 2140, hole: 380 }, // 중간 오른쪽
  ];
  for (const [i, f] of funnels.entries()) {
    const half = 42; // 구멍 반폭
    if (f.hole - half > 45) wallPath(comps, [[25, f.y - 130], [f.hole - half, f.y]]);
    if (f.hole + half < 555) wallPath(comps, [[575, f.y - 130], [f.hole + half, f.y]]);
    // 깔때기 사이 심심하지 않게: 핀 몇 개 + 번갈아 회전체
    lineDots(comps, 150, f.y + 120, 450, f.y + 120, 75, 6);
    if (i % 2 === 0) {
      comps.push({ type: 'cross', x: f.hole, y: f.y + 210, props: { length: 90, speed: i % 4 === 0 ? 4 : -4 } });
    } else {
      comps.push({ type: 'bumper', x: f.hole, y: f.y + 210, props: { size: 16 } });
    }
  }
  // 마지막 구간: 폭탄 지뢰밭
  comps.push({ type: 'bomb', x: 180, y: 2500, props: { radius: 140, power: 14, respawn: 6 } });
  comps.push({ type: 'bomb', x: 420, y: 2500, props: { radius: 140, power: 14, respawn: 6 } });
  const gates = [];
  regroupGate(gates, 1044);
  regroupGate(gates, 1972);
  regroupGate(gates, 2900);
  regroupGate(gates, 3828);
  regroupGate(gates, 4756);
  return [...gates, ...tileY(comps, 2, 2650), ...funnel(5800)];
}

// 💣 지뢰밭: 아무것도 없는 맵에 재생성 폭탄만 —
// 골인 길목의 문지기 폭탄이 선두를 날려버리고, 그 틈에 뒤따라온 공이 우승한다
function minefieldComponents() {
  const comps = [];
  const bomb = (x, y, props = {}) => ({
    type: 'bomb',
    x,
    y,
    props: { radius: 140, power: 14, respawn: 4, ...props },
  });
  // 빽빽한 지뢰 격자: 140px 간격 14줄, 줄마다 4~5개 지그재그 —
  // 어디로 떨어져도 두세 발은 밟는다. 재생성 시간을 3~6초로 엇갈리게 해
  // 폭발 리듬이 겹치지 않고 끊임없이 터진다.
  const H = 4800;
  let i = 0;
  for (let y = 240; y <= H - 320; y += 140) {
    const xs = (y / 140) % 2 === 0 ? [60, 180, 300, 420, 540] : [120, 240, 360, 480];
    for (const x of xs) {
      const jx = Math.round(Math.sin(i * 2.7) * 22); // 결정적 지터 (재시작해도 같은 맵)
      comps.push(
        bomb(Math.min(555, Math.max(45, x + jx)), y, {
          radius: 105 + (i % 3) * 20,
          power: 11 + (i % 3) * 2,
          respawn: 3 + (i % 4),
        })
      );
      i++;
    }
  }
  // 대형 왕지뢰 (구간마다 하나씩)
  comps.push(bomb(300, 1150, { radius: 230, power: 19, respawn: 6 }));
  comps.push(bomb(300, 3350, { radius: 230, power: 19, respawn: 6 }));
  // 🚨 문지기 폭탄 3중 배치: 골인 직전 깔때기 목을 막고 선두를 되받아친다.
  // 터진 뒤 재생성되기 전(게임 시간 6초)에 도착하는 공만 무사히 통과!
  comps.push(bomb(272, H - 130, { radius: 170, power: 19, respawn: 6 }));
  comps.push(bomb(328, H - 130, { radius: 170, power: 19, respawn: 6 }));
  comps.push(bomb(300, H - 80, { radius: 150, power: 17, respawn: 6 }));
  regroupGate(comps, Math.round(H * 0.36));
  regroupGate(comps, Math.round(H * 0.68));
  return [...comps, ...funnel(H)];
}

/** 구성요소 목록을 세로로 n번 반복 — 긴 맵을 콘텐츠로 꽉 채운다 */
function tileY(comps, n, stride) {
  const out = [];
  for (let k = 0; k < n; k++) {
    for (const c of comps) out.push({ ...c, y: c.y + k * stride, props: { ...c.props } });
  }
  return out;
}

// 🌼 활짝 핀 꽃: 꽃잎 링 + 회전 십자 꽃술 + 긴 줄기 + 잎 + 잔디
function flowerComponents() {
  const comps = [];
  const cx = 300;
  const cy = 430;
  ringDots(comps, cx, cy, 90, 12, 8);
  ringDots(comps, cx, cy, 150, 18, 8);
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6 - Math.PI / 2;
    comps.push({
      type: 'bumper',
      x: cx + Math.cos(a) * 208,
      y: cy + Math.sin(a) * 208,
      props: { size: 16 },
    });
  }
  comps.push({ type: 'cross', x: cx, y: cy, props: { length: 90, speed: 3 } });
  // 줄기
  lineDots(comps, 300, 680, 300, 1560, 38);
  // 잎 두 장
  ringDots(comps, 185, 880, 55, 8);
  lineDots(comps, 300, 950, 245, 905, 34);
  ringDots(comps, 415, 1120, 55, 8);
  lineDots(comps, 300, 1190, 355, 1145, 34);
  // 무당벌레 (폭탄)
  comps.push({ type: 'bomb', x: 150, y: 1350, props: { radius: 130, power: 13, respawn: 8 } });
  comps.push({ type: 'bomb', x: 460, y: 1600, props: { radius: 130, power: 13, respawn: 8 } });
  // 🌸 흩날리는 꽃가루(pollen): 줄기 옆 빈 구간을 촘촘한 핀으로 채워 체류시간을 늘린다.
  pegField(comps, 740, 5, { size: 6, gap: 58 });
  pegField(comps, 1660, 5, { size: 6, gap: 58 });
  // 잔디
  for (let i = 0; i < 5; i++) {
    lineDots(comps, 70 + i * 100, 2010, 120 + i * 100, 1940, 34, 6);
  }
  regroupGate(comps, 1056);
  regroupGate(comps, 1920);
  regroupGate(comps, 2784);
  regroupGate(comps, 3648);
  return [...tileY(comps, 2, 2250), ...funnel(4800)];
}

// 👾 픽셀 인베이더: 8비트 외계인 편대 (눈은 폭탄!) + UFO 회전 막대
const INVADER_ART = [
  '..o.....o..',
  '...o...o...',
  '..ooooooo..',
  '.oo@ooo@oo.',
  'ooooooooooo',
  'o.ooooooo.o',
  'o.o.....o.o',
  '...oo.oo...',
];
const INVADER_ART_SMALL = INVADER_ART.map((r) => r.replace(/@/g, 'o'));
function invaderComponents() {
  const comps = [];
  pixelGrid(comps, INVADER_ART, { y0: 250, cell: 40, pegSize: 8 });
  pixelGrid(comps, INVADER_ART_SMALL, { y0: 980, cell: 25, x0: 55, pegSize: 5 });
  pixelGrid(comps, INVADER_ART_SMALL, { y0: 980, cell: 25, x0: 320, pegSize: 5 });
  pixelGrid(comps, INVADER_ART, { y0: 1450, cell: 30, pegSize: 6 });
  // 👾 픽셀 탄막(bullet hail): 편대 사이 빈 구간을 촘촘한 8비트 총알 핀으로 채워 체류시간을 늘린다.
  pegField(comps, 660, 3, { size: 5, gap: 52 });
  pegField(comps, 1770, 2, { size: 5, gap: 52 });
  // UFO: 돔 범퍼 + 회전 막대
  comps.push({ type: 'bumper', x: 300, y: 1960, props: { size: 18 } });
  comps.push({ type: 'spinner', x: 300, y: 2000, props: { length: 200, speed: 6 } });
  regroupGate(comps, 1056);
  regroupGate(comps, 1920);
  regroupGate(comps, 2784);
  regroupGate(comps, 3648);
  return [...tileY(comps, 2, 2250), ...funnel(4800)];
}

// 🍄 대왕 버섯: 갓(호) + 노란 점무늬 + 줄기 얼굴(폭탄 눈) + 아기 버섯들
function mushroomComponents() {
  const comps = [];
  arcDots(comps, 300, 560, 210, -172, -8, 17, 8);
  arcDots(comps, 300, 560, 150, -160, -20, 12, 7);
  lineDots(comps, 110, 560, 490, 560, 40);
  // 갓 점무늬
  for (const [x, y] of [[230, 440], [370, 440], [300, 350], [175, 505], [425, 505]]) {
    comps.push({ type: 'bumper', x, y, props: { size: 15 } });
  }
  // 줄기 + 눈 (폭탄)
  lineDots(comps, 235, 600, 235, 1120, 38);
  lineDots(comps, 365, 600, 365, 1120, 38);
  comps.push({ type: 'bomb', x: 268, y: 780, props: { radius: 120, power: 12, respawn: 8 } });
  comps.push({ type: 'bomb', x: 332, y: 780, props: { radius: 120, power: 12, respawn: 8 } });
  // 바람개비
  comps.push({ type: 'cross', x: 300, y: 1400, props: { length: 120, speed: 4 } });
  // 🍄 흩날리는 포자(spore): 줄기 아래 빈 구간을 촘촘한 핀으로 채워 체류시간을 늘린다.
  pegField(comps, 1180, 4, { size: 6, gap: 56 });
  // 아기 버섯 세 그루
  for (const [x, y] of [[140, 1780], [300, 1930], [465, 1780]]) {
    arcDots(comps, x, y, 70, -170, -10, 7, 6);
    lineDots(comps, x - 18, y + 15, x - 18, y + 85, 35, 5);
    lineDots(comps, x + 18, y + 15, x + 18, y + 85, 35, 5);
  }
  // 아기 버섯 아래 포자 구름
  pegField(comps, 2040, 4, { size: 6, gap: 56 });
  const gates = [];
  regroupGate(gates, 1728);
  regroupGate(gates, 3264);
  return [...gates, ...tileY(comps, 2, 2250), ...funnel(4800)];
}

// 💀 해적 해골: 두개골 + 폭탄 눈 + 이빨 + 엇갈린 뼈다귀(벽) + 유골 별자리
function skullComponents() {
  const comps = [];
  arcDots(comps, 300, 470, 190, -215, 35, 22, 8);
  // 눈: 붉게 빛나는 폭탄
  comps.push({ type: 'bomb', x: 232, y: 435, props: { radius: 130, power: 13, respawn: 7 } });
  comps.push({ type: 'bomb', x: 368, y: 435, props: { radius: 130, power: 13, respawn: 7 } });
  // 코
  comps.push(peg(300, 545, 7));
  comps.push(peg(286, 572, 7));
  comps.push(peg(314, 572, 7));
  // 턱 라인 + 이빨
  lineDots(comps, 152, 580, 195, 665, 36);
  lineDots(comps, 448, 580, 405, 665, 36);
  for (let x = 218; x <= 382; x += 41) {
    comps.push(peg(x, 660, 6));
    comps.push(peg(x, 692, 6));
  }
  // 엇갈린 뼈다귀: 가운데가 뚫린 X — 교차점 V홈에 공이 끼지 않도록 4토막
  for (const ang of [40, -40]) {
    const rad = (ang * Math.PI) / 180;
    for (const dir of [-1, 1]) {
      comps.push({
        type: 'wall',
        x: 300 + Math.cos(rad) * 105 * dir,
        y: 1250 + Math.sin(rad) * 105 * dir,
        props: { length: 120, angle: ang },
      });
    }
  }
  for (const [x, y] of [[182, 1152], [418, 1152], [182, 1348], [418, 1348]]) {
    comps.push({ type: 'bumper', x, y, props: { size: 14 } });
  }
  // 유골 별자리 + 유령 바람개비
  for (const [x, y] of [[120, 1620], [250, 1700], [480, 1650], [370, 1800], [150, 1900], [520, 1950]]) {
    comps.push(peg(x, y, 6));
  }
  comps.push({ type: 'cross', x: 200, y: 1780, props: { length: 100, speed: -4 } });
  comps.push({ type: 'cross', x: 420, y: 1950, props: { length: 100, speed: 4 } });
  // 🦴 뼛가루 모래톱(bone-dust shoal): 빈 구간을 촘촘한 핀 밭으로 채워 체류시간을 늘린다.
  pegField(comps, 820, 5);   // 두개골과 뼈다귀 사이
  pegField(comps, 2010, 6);  // 별자리 아래
  const gates = [];
  regroupGate(gates, 1728);
  regroupGate(gates, 3264);
  return [...gates, ...tileY(comps, 2, 2250), ...funnel(4800)];
}

// 🚀 로켓 발사: 기체 + 창문 + 날개 + 회전 불꽃 + 별밤
function rocketComponents() {
  const comps = [];
  // 기수(원뿔)
  lineDots(comps, 300, 200, 215, 400, 36);
  lineDots(comps, 300, 200, 385, 400, 36);
  // 동체
  lineDots(comps, 215, 400, 215, 1120, 38);
  lineDots(comps, 385, 400, 385, 1120, 38);
  // 창문
  ringDots(comps, 300, 580, 55, 10);
  comps.push({ type: 'bumper', x: 300, y: 580, props: { size: 16 } });
  // 무늬 띠
  lineDots(comps, 245, 790, 355, 790, 38, 6);
  // 날개
  comps.push({ type: 'wall', x: 168, y: 1180, props: { length: 170, angle: 60 } });
  comps.push({ type: 'wall', x: 432, y: 1180, props: { length: 170, angle: -60 } });
  lineDots(comps, 235, 1160, 365, 1160, 42, 6);
  // 불꽃: 회전체 + 폭탄 (진짜로 폭발하는 배기가스)
  comps.push({ type: 'cross', x: 300, y: 1310, props: { length: 110, speed: 7 } });
  comps.push({ type: 'spinner', x: 245, y: 1480, props: { length: 90, speed: -6 } });
  comps.push({ type: 'spinner', x: 355, y: 1480, props: { length: 90, speed: 6 } });
  comps.push({ type: 'bumper', x: 262, y: 1600, props: { size: 13 } });
  comps.push({ type: 'bumper', x: 338, y: 1600, props: { size: 13 } });
  comps.push({ type: 'bomb', x: 300, y: 1700, props: { radius: 150, power: 15, respawn: 7 } });
  // 별밤 + 초승달
  for (const [x, y] of [[95, 1950], [210, 2060], [480, 1990], [370, 2160], [130, 2300], [520, 2280], [300, 2380], [450, 2480], [180, 2540]]) {
    comps.push(peg(x, y, 6));
  }
  comps.push({ type: 'bumper', x: 90, y: 2150, props: { size: 14 } });
  comps.push({ type: 'bumper', x: 540, y: 2420, props: { size: 14 } });
  arcDots(comps, 470, 2100, 75, -140, 60, 9, 6);
  // ☄️ 소행성대(asteroid belt): 배기가스 아래·별밤 끝의 빈 우주를 촘촘한 핀으로 채워
  //    선체를 빠져나온 공이 소행성에 부딪히며 느리게 표류하도록 한다.
  pegField(comps, 1800, 3, { size: 6, gap: 60 });
  pegField(comps, 2600, 4, { size: 6, gap: 60 });
  regroupGate(comps, 1080);
  regroupGate(comps, 2040);
  regroupGate(comps, 3000);
  regroupGate(comps, 3960);
  regroupGate(comps, 4920);
  return [...tileY(comps, 2, 2800), ...funnel(6000)];
}

// ❤️ 하트 폭포: 점점 작아지는 하트 셋 — 마지막 심장은 터진다
function heartDots(comps, cx, cy, s, n, size = 7, open = 0.45) {
  for (let i = 0; i < n; i++) {
    const t = (Math.PI * 2 * i) / n;
    // 위 골짜기(t≈0)와 아래 꼭짓점(t≈π)은 점이 밀집해 공이 갇히므로 뚫어둔다
    if (Math.abs(Math.sin(t)) < open) continue;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    comps.push(peg(cx + x * s, cy - y * s, size));
  }
}
function heartsComponents() {
  const comps = [];
  heartDots(comps, 300, 500, 13, 30, 8, 0.45);
  comps.push({ type: 'bumper', x: 300, y: 480, props: { size: 18 } });
  // 큐피드 화살
  comps.push({ type: 'wall', x: 300, y: 520, props: { length: 300, angle: -20 } });
  comps.push({ type: 'bumper', x: 445, y: 468, props: { size: 13 } });
  heartDots(comps, 195, 1220, 8, 22, 7, 0.35);
  comps.push({ type: 'bumper', x: 195, y: 1208, props: { size: 15 } });
  heartDots(comps, 405, 1650, 6.5, 18, 6, 0.3);
  comps.push({ type: 'bomb', x: 405, y: 1642, props: { radius: 140, power: 14, respawn: 8 } });
  // 반짝이 별가루
  for (const [x, y] of [[490, 950], [110, 1500], [520, 1350], [90, 1800], [300, 1500]]) {
    comps.push(peg(x, y, 6));
  }
  // 💕 흩날리는 꽃잎 눈꽃(petal flurry): 하트 사이 빈 구간을 촘촘한 핀으로 채워 체류시간을 늘린다.
  pegField(comps, 830, 5, { size: 6, gap: 58 });
  pegField(comps, 1770, 4, { size: 6, gap: 58 });
  // 두근두근 바람개비
  comps.push({ type: 'cross', x: 300, y: 1980, props: { length: 130, speed: 5 } });
  const gates = [];
  regroupGate(gates, 1056);
  regroupGate(gates, 1920);
  regroupGate(gates, 2784);
  regroupGate(gates, 3648);
  return [...gates, ...tileY(comps, 2, 2250), ...funnel(4800)];
}


// 🕹️ 진짜 핀볼: 곡선 어깨 레일 + ⚡3구 범퍼 클러스터 + 중앙 대형 회전 타깃
//   + 중앙 킥커(공이 닿으면 위로 되돌려 보냄) + 하단 플리퍼 + 왼쪽 행운의 샛길
function pinballComponents() {
  const H = 3200;
  const comps = [];
  const B = (x, y, size = 20) => comps.push({ type: 'bumper', x, y, props: { size } });
  const S = (x, y, length, speed) =>
    comps.push({ type: 'spinner', x, y, props: { length, speed } });

  // ── 상단 플레이필드: 곡선 어깨 레일 + ⚡ 3구 범퍼 클러스터(핀볼의 상징) ──
  // 넓게 퍼져 출발한 공을 안쪽 범퍼 지대로 모으는 곡선 레일 (레퍼런스 상단의 스윙 레일)
  wallPath(comps, [[25, 250], [95, 430], [220, 530]]);
  wallPath(comps, [[575, 250], [505, 430], [380, 530]]);
  B(300, 250, 24);
  B(250, 340, 22);
  B(350, 340, 22);
  lineDots(comps, 150, 420, 210, 470, 30, 6);
  lineDots(comps, 450, 420, 390, 470, 30, 6);

  // ── 중상단: 스피너 쌍 + 사이드 슬링샷 범퍼 (사이 빈 구간에 핀 밭 추가) ──
  pegField(comps, 560, 2, { size: 6, gap: 52 });
  S(165, 690, 150, 4);
  S(435, 690, 150, -4);
  B(90, 800, 16);
  B(510, 800, 16);
  pegField(comps, 860, 2, { size: 6, gap: 52, x0: 200, x1: 400 });
  wallPath(comps, [[25, 960], [200, 1050]]);
  wallPath(comps, [[575, 960], [400, 1050]]);

  // ── 중앙 대형 회전 타깃(레퍼런스의 방사형 휠) + 둘레 범퍼 링 ──
  // 링의 맨 아래(i=4)는 비워서 공이 중앙 킥커로 흘러내리는 길을 연다
  const cx = 300;
  const cy = 1280;
  S(cx, cy, 200, 5);
  for (let i = 0; i < 8; i++) {
    if (i === 4) continue;
    const a = (Math.PI * 2 * i) / 8 - Math.PI / 2;
    B(Math.round(cx + Math.cos(a) * 150), Math.round(cy + Math.sin(a) * 150), 15);
  }

  // ── 중앙 킥커: 공이 닿으면 위로 쏘아 되돌려 보낸다 (핵심 요청) ──
  // 위쪽 V자 깔때기가 중앙 물줄기를 킥커로 모아 안정적으로 발동시킨다
  comps.push({ type: 'wall', x: 224, y: 1500, props: { length: 130, angle: 30 } });
  comps.push({ type: 'wall', x: 376, y: 1500, props: { length: 130, angle: -30 } });
  comps.push({ type: 'jumper', x: 300, y: 1600, props: { width: 130, power: 15, angle: 0 } });

  // ── 휠 양옆 핀 클러스터: 핀볼답게 촘촘한 핀으로 채워 좌우로 흐르며 지체하게 한다 ──
  pegField(comps, 1090, 3, { size: 6, gap: 50, x0: 65, x1: 205 });
  pegField(comps, 1090, 3, { size: 6, gap: 50, x0: 395, x1: 535 });

  // ── 하단 플레이필드: 범퍼·핀 밭 + 회전체 (핀 밭을 위로 넓혀 체류시간을 늘림) ──
  B(150, 1780, 18);
  B(450, 1780, 18);
  S(300, 1800, 140, -4);
  pegField(comps, 1880, 4, { size: 7, gap: 54 });
  pegRow(comps, 2030, 27);
  B(120, 2120, 16);
  B(480, 2120, 16);
  B(300, 2160, 20);

  // ── 왼쪽 행운의 샛길: 안쪽 벽으로 통로를 만들고 입구는 좁게 —
  //    운좋게 슬쩍 빠진 공은 장애물 없이 그대로 골인까지 직행한다 ──
  wallPath(comps, [[110, 2260], [110, 2880]]); // 샛길 안쪽(수직) 벽 → 왼쪽 통로 형성
  wallPath(comps, [[110, 2260], [190, 2205]]); // 입구 가림막 — 대부분 튕겨나가고 운좋으면 진입

  // ── 오른쪽 하단 퍼올리기(욕망의 항아리 방식): 회전 바가 흘러온 공을 위로 퍼올린다 ──
  // 오른쪽으로 흘러온 공을 스쿱 바로 모으는 짧은 유도벽 + 아래 받침으로 헛돌지 않게 함
  comps.push({ type: 'wall', x: 548, y: 2250, props: { length: 130, angle: 64 } });
  comps.push({ type: 'wall', x: 505, y: 2560, props: { length: 120, angle: -20 } });
  comps.push({ type: 'spinner', x: 512, y: 2430, props: { length: 150, speed: -5 } });

  // ── 하단 플리퍼: 두 날개(레퍼런스의 흰 삼각형) — 가운데 배수구로 유도 ──
  comps.push({ type: 'wall', x: 250, y: 2760, props: { length: 170, angle: 24 } });
  comps.push({ type: 'wall', x: 420, y: 2770, props: { length: 130, angle: -34 } });
  B(300, 2600, 16);

  return [...comps, ...funnel(H)];
}

// 🤝 손에손잡고 벽을 넘어서: 다같이 두드려 깨는 '사라지는 벽'(벽을 넘어서) +
//    링 사슬(손에 손잡고)로 이어지는 하강 코스. 88 서울올림픽 주제가 오마주.
function handInHandComponents() {
  const comps = [];
  const H = 4800;
  const ring = (x, y, r, extra = {}) => {
    comps.push({ type: 'ring', x, y, props: { radius: r, thickness: 10, gap: 0, gapDir: 90, ...extra } });
    // 정수리에 회전 십자 = 능동 청소기: 닫힌 링은 꼭대기에 공이 얹혀 고이기 쉬운데,
    // 십자가 그 자리를 계속 쓸어내 공이 멈추지 못하게 한다(실측: 고임 대폭 감소).
    comps.push({ type: 'cross', x, y: y - r, props: { length: Math.min(130, r * 2 + 16), speed: 4 } });
  };
  const bwall = (x, y, len, ang, hits) =>
    comps.push({ type: 'wall', x, y, props: { length: len, angle: ang, curve: 0, breakHits: hits } });
  // 전폭 '사라지는 벽' — 길이 상한(300) 때문에 두 조각으로 나눠 좌우를 잇는다(가운데 겹침).
  //  좌/우 조각이 각자 hits 번 맞으면 무너져, 다같이 두드리면 뚫린다.
  const dam = (y, hits) => {
    bwall(155, y, 290, 0, hits);
    bwall(445, y, 290, 0, hits);
  };
  // 벽 위로 공을 유도하는 얕은 핀 줄
  const guide = (y) => lineDots(comps, 80, y, 520, y, 72, 6);

  // ── 인트로: 핀 + 범퍼로 공을 넓게 퍼뜨리고 속도를 준다 (링 앞에서 정체 방지) ──
  lineDots(comps, 70, 210, 530, 210, 58, 7);
  comps.push({ type: 'bumper', x: 300, y: 300, props: { size: 22 } });
  comps.push({ type: 'bumper', x: 130, y: 360, props: { size: 16 } });
  comps.push({ type: 'bumper', x: 470, y: 360, props: { size: 16 } });

  // ── 손에 손잡고: 링 사슬 (충분히 낙하해 속도가 붙은 뒤 통과 — 정수리에 고이지 않게) ──
  //    간격 D > 2R+공지름 이어야 위 골짜기로 흘러든 공이 사이로 빠진다. 각 링엔 정수리 가드 핀.
  ring(300, 520, 54);

  // ── 첫 번째 벽 (가볍게, 4회) ──
  guide(660);
  dam(750, 8);

  // ── 장애물: 닫힌 도넛 + 범퍼 + 스피너 (도넛 앞뒤로 범퍼가 공을 계속 튕겨 정체 방지) ──
  comps.push({ type: 'bumper', x: 150, y: 900, props: { size: 18 } });
  comps.push({ type: 'bumper', x: 450, y: 900, props: { size: 18 } });
  ring(300, 960, 52);
  comps.push({ type: 'spinner', x: 300, y: 1120, props: { length: 170, speed: 4 } });

  // ── 두 번째 벽 (12회) ──
  guide(1290);
  dam(1370, 12);

  // ── 링 터널: 도넛 세 개(한 줄, 넉넉한 간격) 사이를 지난다 (앞에 범퍼로 속도 부여) ──
  ring(200, 1620, 52);
  comps.push({ type: 'cross', x: 300, y: 1860, props: { length: 120, speed: -4 } });

  // ── 세 번째 벽 (14회) ──
  guide(2060);
  dam(2140, 16);

  // ── 핀 + 범퍼 통통 구간 (공을 가두지 않고 튕겨 흐르게) ──
  lineDots(comps, 90, 2380, 510, 2380, 58, 6);
  comps.push({ type: 'bumper', x: 150, y: 2500, props: { size: 18 } });
  comps.push({ type: 'bumper', x: 300, y: 2470, props: { size: 20 } });
  comps.push({ type: 'bumper', x: 450, y: 2500, props: { size: 18 } });
  comps.push({ type: 'cross', x: 300, y: 2630, props: { length: 110, speed: 4 } });

  // ── 네 번째 벽 (가장 튼튼, 16회) ──
  guide(2720);
  dam(2800, 20);

  // ── 링 무리(한 줄) + 스피너 관문 ──
  ring(400, 3040, 52);
  comps.push({ type: 'spinner', x: 190, y: 3260, props: { length: 150, speed: 5 } });
  comps.push({ type: 'spinner', x: 410, y: 3260, props: { length: 150, speed: -5 } });

  // ── 다섯 번째 벽 (마지막 관문, 12회) ──
  guide(3480);
  dam(3560, 12);

  // ── 피날레: 링 + 십자 + 핀 ──
  ring(300, 3820, 54);
  comps.push({ type: 'cross', x: 300, y: 4040, props: { length: 130, speed: 4 } });
  lineDots(comps, 90, 4230, 510, 4230, 64, 6);

  return [...comps, ...funnel(H)];
}

// 🌈 무지개 나라: 방향이 제각각인 반 도넛 무지개(아래∩·왼쪽)·오른쪽() 아치들 사이로
//    공이 알록달록 쏟아져 내려간다. ∩ 아치는 정수리에 회전 청소기로 고임 방지.
function rainbowComponents() {
  const comps = [];
  const H = 4800;
  // dir: 0=아래∩ · 1=왼쪽) · 2=오른쪽( (위∪=3 은 공을 가두므로 맵에선 쓰지 않음)
  const rb = (x, y, radius, dir, band = 8, bounce = 0.4) =>
    comps.push({ type: 'rainbow', x, y, props: { radius, band, dir, bounce } });
  const bump = (x, y, s = 16) => comps.push({ type: 'bumper', x, y, props: { size: s } });

  // ── 인트로: 핀 + 범퍼로 넓게 퍼뜨리고 속도를 준다 ──
  lineDots(comps, 70, 200, 530, 200, 56, 7);
  bump(300, 290, 20); bump(140, 350, 15); bump(460, 350, 15);

  // ── 1층: 가운데 큰 ∩ 무지개 (정수리 청소기) ──
  rb(300, 470, 118, 0);
  // ── 2층: 양옆에서 마주보는 )( 무지개 → 공을 가운데로 모은다 ──
  rb(120, 760, 96, 1); // 왼쪽에 ')' (열림 왼쪽=벽쪽) → 볼록면이 가운데로
  rb(480, 760, 96, 2); // 오른쪽에 '(' (열림 오른쪽=벽쪽)
  bump(300, 780, 18);

  // ── 3층: 작은 ∩ 두 개 (좌우, 청소기) ──
  rb(175, 1080, 82, 0);  rb(425, 1080, 82, 0);
  // ── 4층: 가운데 큰 ∩ + 사이드 범퍼 ──
  rb(300, 1400, 120, 0);  bump(90, 1360, 15); bump(510, 1360, 15);

  // ── 5층: 바깥을 보는 () 무지개 (공을 바깥→아래로 흘린다) ──
  rb(160, 1720, 92, 2); // '(' 열림 오른쪽(가운데쪽), 볼록면이 왼벽쪽
  rb(440, 1720, 92, 1); // ')' 열림 왼쪽(가운데쪽), 볼록면이 오른벽쪽
  comps.push({ type: 'spinner', x: 300, y: 1780, props: { length: 150, speed: 5 } });

  // 🌧️ 빗방울 커튼: 5층과 6층 사이 빈 구간에 촘촘한 핀
  pegField(comps, 1540, 4, { size: 6, gap: 52 });
  // ── 6층: 지그재그 ∩ 세 개 ──
  rb(150, 2040, 78, 0);  rb(300, 2120, 78, 0);  rb(450, 2040, 78, 0);
  // ── 7층: 마주보는 )( + 가운데 십자 ──
  rb(130, 2420, 90, 1); rb(470, 2420, 90, 2);
  comps.push({ type: 'cross', x: 300, y: 2460, props: { length: 120, speed: -4 } });

  // ── 8층: 통통 범퍼밭 ──
  bump(150, 2680, 18); bump(300, 2640, 20); bump(450, 2680, 18);
  lineDots(comps, 90, 2760, 510, 2760, 60, 6);

  // 🌧️ 무지개 사이 빗방울(raindrops): 아치 사이 빈 구간을 촘촘한 핀으로 채워 체류시간을 늘린다.
  pegField(comps, 2840, 4, { size: 6, gap: 52 });

  // ── 9층: 큰 ∩ 무지개 관문 ──
  rb(300, 3000, 122, 0);
  // ── 10층: 바깥 () + 스피너 ──
  rb(165, 3300, 92, 2); rb(435, 3300, 92, 1);
  comps.push({ type: 'spinner', x: 190, y: 3360, props: { length: 140, speed: 5 } });
  comps.push({ type: 'spinner', x: 410, y: 3360, props: { length: 140, speed: -5 } });

  // ── 11층: 작은 ∩ 무지개 사슬 ──
  rb(150, 3620, 80, 0);  rb(300, 3700, 80, 0);  rb(450, 3620, 80, 0);
  // ── 피날레: 마주보는 )( + 통통 범퍼 + 핀 ──
  rb(140, 3980, 96, 1); rb(460, 3980, 96, 2);
  bump(300, 4020, 20);
  lineDots(comps, 90, 4200, 510, 4200, 62, 6);

  regroupGate(comps, Math.round(H * 0.36));
  regroupGate(comps, Math.round(H * 0.68));
  return [...comps, ...funnel(H)];
}

// ── 🎁 아이템 맵 ────────────────────────────────────────
// 아이템전(시작할 때 각자 아이템 2개)을 쓰지 않는 대신, 맵 위에 놓인 아이템을
// 주워서 쓰게 하는 맵들. 공이 닿는 순간 '그 공'이 효과를 받는다
// (server/game.js 의 HIT_ACTIONS.item / powerup).
//
// 그래서 이로운 아이템은 주운 공에게 이득이고, 방해 아이템은 주운 공이
// 그대로 당한다 — 줍는 게 늘 좋은 일은 아니라는 점이 이 맵들의 재미다.

/** 🎁 무작위 아이템 상자 */
function box(x, y, respawn = 5) {
  return { type: 'itembox', x: Math.round(x), y: Math.round(y), props: { respawn } };
}
/** 지정 아이템 한 개 (item_<id> 구성요소) */
function itm(id, x, y, respawn = 6) {
  return { type: 'item_' + id, x: Math.round(x), y: Math.round(y), props: { respawn } };
}
// 주운 공에게 이로운 것(가볍다) / 주운 공이 당하는 것 / 판을 통째로 흔드는 것.
// 큰 것은 아껴 쓴다 — 번개·시간정지가 흔해지면 남의 공이 계속 멈춰 있어 보는 재미가 죽는다.
const GOOD_ITEMS = ['rocket', 'ghost', 'magnet', 'shockwave'];
const BAD_ITEMS = ['freeze', 'gust', 'morph', 'balloon'];
const BIG_ITEMS = ['lightning', 'timestop', 'clone'];
/** 결정적 선택 — 새로고침해도 늘 같은 맵이 나오도록 난수를 쓰지 않는다 */
const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];

/**
 * 🚧 재집결 관문 — 화면 전폭을 가로막는 '사라지는 벽'.
 *
 * 앞선 공이 여기서 막혀 기다리는 동안 뒤처진 공이 따라붙는다. 벌어진 간격을
 * 되돌리는 유일한 장치다. 실측에서 이 장치를 쓰는 '손에손잡고' 맵만 전원표시율
 * 76%로, 다른 맵(21~42%)과 차원이 다른 수치를 냈다.
 *
 * 벽 길이 상한(300) 때문에 좌우 두 조각으로 나눠 잇는다. 조각마다 따로 hits 를
 * 세므로 한쪽만 먼저 뚫릴 수 있고, 그 좁은 틈으로 몰리는 것도 볼거리가 된다.
 */
function regroupGate(comps, y, hits = 9) {
  comps.push({ type: 'wall', x: 155, y, props: { length: 290, angle: 0, breakHits: hits } });
  comps.push({ type: 'wall', x: 445, y, props: { length: 290, angle: 0, breakHits: hits } });
}

// 🎁 아이템 클래식: 익숙한 클래식 핀밭에 아이템을 흩뿌린 기본 맵.
//    핀 몇 개 자리를 아이템으로 바꿔 놓아, 어디로 떨어져도 두어 개는 줍는다.
// 기본 맵이라 다른 맵보다 짧게 잡는다(3800). 핀밭이 촘촘해 관문까지 겹치면 판이
// 15초 가까이 늘어지는데, 맵을 줄이면 벌어질 거리 자체가 줄어 판도 짧아진다.
const ITEM_CLASSIC_H = 3800;
function itemClassicComponents() {
  const comps = [];
  const H = ITEM_CLASSIC_H;
  let row = 0;
  for (let y = 170; y <= H - 260; y += 62) {
    const offset = row % 2 === 0 ? 0 : 29;
    let col = 0;
    for (let x = 55 + offset; x <= 545; x += 58) {
      // 네 줄마다 한 번, 줄에서 두 자리를 아이템으로 — 핀밭의 결은 그대로 두고 알맹이만 바꾼다
      // 아이템은 네 줄이 아니라 여덟 줄마다. 구조가 똑같은 '클래식'이 62%인데 이 맵이
      // 47%인 건 순전히 아이템 타일 때문이라, 밀도를 절반으로 낮춰 균형을 맞춘다.
      const swap = row % 8 === 2 && (col === 2 + (row % 3) || col === 6 - (row % 3));
      if (swap) {
        if (row % 8 === 2) comps.push(box(x, y));
        else if (row % 12 === 6 && col < 4) comps.push(itm(pick(BIG_ITEMS, row), x, y, 9)); // 큰 것은 드물게
        else comps.push(itm(pick(row % 3 === 0 ? BAD_ITEMS : GOOD_ITEMS, row + col), x, y));
      } else {
        comps.push(peg(x, y));
      }
      col++;
    }
    row++;
  }
  // 골인 직전 마지막 기회 — 깔때기 입구 양옆에 상자 하나씩
  comps.push(box(150, H - 300, 4), box(450, H - 300, 4));
  // 🚧 재집결 관문 — 판을 셋으로 끊어 벌어진 간격을 두 번 되돌린다
  regroupGate(comps, 1064);
  regroupGate(comps, 1976);
  regroupGate(comps, 2888);
  return [...comps, ...funnel(H)];
}


// 😇 천사와 악마: 좌우가 축복과 저주로 갈린 맵. 구간마다 좌우가 뒤바뀌어
//    한쪽 벽만 타고 내려가는 얌체 경로가 통하지 않는다.
function angelDevilComponents() {
  const comps = [];
  const H = 4800;
  const BAND = 470;
  let band = 0;
  for (let y = 240; y <= H - 420; y += BAND) {
    const goodLeft = band % 2 === 0; // 구간마다 축복/저주 쪽이 바뀐다
    const gx = goodLeft ? [95, 175, 255] : [345, 425, 505];
    const bx = goodLeft ? [345, 425, 505] : [95, 175, 255];
    // 축복 쪽 세 자리 중 가운데 한 자리는 세 구간마다 큰 아이템으로 (천사 쪽의 대박)
    gx.forEach((x, i) =>
      comps.push(
        i === 1 && band % 3 === 1
          ? itm(pick(BIG_ITEMS, band), x, y + i * 58, 10)
          : itm(pick(GOOD_ITEMS, band + i), x, y + i * 58)
      )
    );
    bx.forEach((x, i) => comps.push(itm(pick(BAD_ITEMS, band + i), x, y + i * 58)));
    // 구간 머리의 삿갓(∧) — 가운데로 온 공을 좌우로 흘려보낸다.
    // (∨ 로 두면 전부 가운데로 모여 좌우 아이템을 다 건너뛰고 정체까지 생긴다)
    comps.push({ type: 'bumper', x: 300, y: y - 100, props: { size: 20 } });
    comps.push({ type: 'wall', x: 232, y: y - 58, props: { length: 170, angle: -26 } });
    comps.push({ type: 'wall', x: 368, y: y - 58, props: { length: 170, angle: 26 } });
    // 구간 꼬리에 핀 한 줄 — 다음 구간으로 넘어가며 좌우가 섞이도록
    pegRow(comps, y + 215);
    band++;
  }
  regroupGate(comps, 1056);
  regroupGate(comps, 1920);
  regroupGate(comps, 2784);
  regroupGate(comps, 3648);
  return [...comps, ...funnel(H)];
}


// 🪜 아이템 계단: 좌우로 꺾이는 비탈을 타고 내려오다 비탈 끝에서 반드시
//    아이템 하나를 밟는다. 무엇을 밟을지는 어느 비탈을 탔느냐로 정해진다.
// 비탈 하나가 300px 넘게 가로지르는 구조라 거리가 길수록 격차가 커진다.
// 아이템 클래식과 같은 처방 — 맵을 줄여 벌어질 거리 자체를 줄인다.
const ITEM_STAIRS_H = 3700;
function itemStairsComponents() {
  const comps = [];
  const H = ITEM_STAIRS_H;
  let step = 0;
  // 비탈은 가파르게(약 30°) — 완만하면 공이 굴러 내려오는 데만 한참 걸려 판이 늘어진다
  for (let y = 300; y <= H - 460; y += 340) {
    const toRight = step % 2 === 0;
    const x1 = toRight ? 80 : 520;
    const x2 = toRight ? 430 : 170;
    wallPath(comps, [[x1, y], [x2, y + 190]]); // 끝은 열어 두어 공이 굴러 떨어지게
    // 비탈 끝 바로 아래 — 굴러 떨어진 공이 여기에 꽂힌다
    const tipX = toRight ? x2 + 55 : x2 - 55;
    comps.push(
      step % 6 === 4
        ? itm(pick(BIG_ITEMS, step), tipX, y + 250, 10) // 여섯 칸에 한 번은 큰 것
        : itm(pick(step % 3 === 2 ? BAD_ITEMS : GOOD_ITEMS, step), tipX, y + 250, 6)
    );
    // 비탈을 타지 않고 반대쪽으로 튄 공을 위한 뒷길 아이템 (반대편 벽 쪽)
    comps.push(box(toRight ? 550 : 50, y + 110, 7));
    step++;
  }
  regroupGate(comps, 740);
  regroupGate(comps, 1406);
  regroupGate(comps, 2072);
  regroupGate(comps, 2738);
  return [...comps, ...funnel(H)];
}

const BUILTIN_MAPS = [
  // ── 🎁 아이템 맵: 맵에 놓인 아이템을 주워 쓴다 (아이템전 없이도 변수가 생긴다) ──
  {
    id: 'item-classic',
    name: '🎁 아이템 클래식',
    author: '기본 맵',
    builtin: true,
    height: ITEM_CLASSIC_H,
    components: itemClassicComponents(),
  },
  {
    id: 'angel-devil',
    name: '😇 천사와 악마',
    author: '기본 맵',
    builtin: true,
    height: 4800,
    components: angelDevilComponents(),
  },
  {
    id: 'item-stairs',
    name: '🪜 아이템 계단',
    author: '기본 맵',
    builtin: true,
    height: ITEM_STAIRS_H,
    components: itemStairsComponents(),
  },
  {
    id: 'classic',
    name: '클래식',
    author: '기본 맵',
    builtin: true,
    height: WORLD.height,
    components: classicComponents(),
  },
  {
    id: 'spinner-park',
    name: '스피너 파크',
    author: '기본 맵',
    builtin: true,
    height: WORLD.height,
    components: spinnerParkComponents(),
  },
  {
    id: 'pinball',
    name: '🕹️ 진짜 핀볼',
    author: '기본 맵',
    builtin: true,
    height: 3200,
    components: pinballComponents(),
  },
  {
    id: 'handinhand',
    name: '🤝 손에손잡고 벽을 넘어서',
    author: '기본 맵',
    builtin: true,
    height: 4800,
    components: handInHandComponents(),
  },
  {
    id: 'rainbowland',
    name: '🌈 무지개 나라',
    author: '기본 맵',
    builtin: true,
    height: 4800,
    components: rainbowComponents(),
  },
  // ── 미니맵 아트 맵: 미니맵으로 보면 그림, 게임에선 핀·범퍼·회전체·폭탄 ──
  {
    id: 'flower',
    name: '🌼 활짝 핀 꽃',
    author: '기본 맵',
    builtin: true,
    height: 4800,
    components: flowerComponents(),
  },
  {
    id: 'invader',
    name: '👾 픽셀 인베이더',
    author: '기본 맵',
    builtin: true,
    height: 4800,
    components: invaderComponents(),
  },
  {
    id: 'mushroom',
    name: '🍄 대왕 버섯',
    author: '기본 맵',
    builtin: true,
    height: 4800,
    components: mushroomComponents(),
  },
  {
    id: 'skull',
    name: '💀 해적 해골',
    author: '기본 맵',
    builtin: true,
    height: 4800,
    components: skullComponents(),
  },
  {
    id: 'rocket',
    name: '🚀 로켓 발사',
    author: '기본 맵',
    builtin: true,
    height: 6000,
    components: rocketComponents(),
  },
  {
    id: 'hearts',
    name: '❤️ 하트 폭포',
    author: '기본 맵',
    builtin: true,
    height: 4800,
    components: heartsComponents(),
  },
  {
    id: 'minefield',
    name: '💣 지뢰밭',
    author: '기본 맵',
    builtin: true,
    height: 4800,
    components: minefieldComponents(),
  },
  // ── 코스형 맵: 벽에 부딪히며 좌우로 꺾여 내려간다 ──
  {
    id: 'canyon',
    name: '🐍 지그재그 협곡',
    author: '기본 맵',
    builtin: true,
    height: 6400,
    components: canyonComponents(),
  },
  {
    id: 'cascade',
    name: '🌪 깔때기 폭포',
    author: '기본 맵',
    builtin: true,
    height: 5800,
    components: cascadeComponents(),
  },
];

// ── 저장소 ──────────────────────────────────────────────

class MapStore {
  constructor() {
    this.builtins = new Map(BUILTIN_MAPS.map((m) => [m.id, m]));
    this.custom = new Map();
    this.overrides = new Map(); // 기본 맵 id -> 관리자가 편집한 버전 (기본값은 코드에 그대로 남김)
    this.dailyByKey = new Map(); // `${date}|${creatorKey}` -> 오늘 생성 수
    this.load();
  }

  load() {
    try {
      const arr = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const m of arr) {
        m.height = m.height || WORLD.height; // 길이 필드가 없는 예전 맵 호환
        this.custom.set(m.id, m);
      }
    } catch {
      /* 파일 없으면 무시 */
    }
    try {
      const ov = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
      for (const m of ov) if (this.builtins.has(m.id)) this.overrides.set(m.id, m);
    } catch {
      /* 오버라이드 없으면 무시 */
    }
  }

  persist() {
    atomicWriteJSON(DATA_FILE, [...this.custom.values()]);
  }
  persistOverrides() {
    atomicWriteJSON(OVERRIDE_FILE, [...this.overrides.values()]);
  }

  /** 기본 맵의 실효 버전 (편집됐으면 편집본) */
  effectiveBuiltin(m) {
    return this.overrides.get(m.id) || m;
  }

  /** 맵 목록 (메타데이터만) */
  list() {
    const meta = (m) => ({
      id: m.id,
      name: m.name,
      author: m.author,
      builtin: !!m.builtin,
      count: m.components.length,
      height: m.height,
      ...(m.width ? { width: m.width } : {}),
    });
    const builtinEff = [...this.builtins.values()].map((m) => this.effectiveBuiltin(m));
    return [...builtinEff, ...this.custom.values()].map(meta);
  }

  get(id) {
    return this.overrides.get(id) || this.builtins.get(id) || this.custom.get(id) || null;
  }

  /** 이름·길이·구성요소 검증 후 정제된 값을 반환 (save/update 공용) */
  _validate({ name, components, height, width, finish, autoKickers }, maxComp = MAX_COMPONENTS) {
    const cleanName = String(name || '').trim().slice(0, 20);
    if (!cleanName) return { ok: false, error: '맵 이름을 입력해주세요.' };
    if (!Array.isArray(components) || components.length === 0)
      return { ok: false, error: '구성요소를 1개 이상 배치해주세요.' };
    if (components.length > maxComp)
      return { ok: false, error: `구성요소는 최대 ${maxComp}개까지 가능합니다.` };

    const h = Number(height);
    const cleanHeight = Number.isFinite(h)
      ? Math.round(clamp(h, WORLD.minHeight, WORLD.maxHeight) / 50) * 50
      : WORLD.height;
    const cleanWidth = clampWidth(width); // 맵 폭 (없으면 기본 600)
    const maxY = cleanHeight - 100;
    const maxX = cleanWidth - BOUNDS.minX; // 좌우 여백은 폭에 맞춰 대칭
    // 🏁 골인 존: 지정됐으면 맵 폭·길이에 맞게 정제해 저장(없으면 undefined → 기본 위치)
    const cleanFinish = finish ? clampFinish(finish, cleanHeight, cleanWidth) : undefined;

    const validated = [];
    for (const comp of components) {
      const def = lookupComponent(comp && comp.type);
      if (!def) return { ok: false, error: `알 수 없는 구성요소: ${comp && comp.type}` };

      const x = clamp(Number(comp.x), BOUNDS.minX, maxX);
      const y = clamp(Number(comp.y), BOUNDS.minY, maxY);
      if (!Number.isFinite(x) || !Number.isFinite(y))
        return { ok: false, error: '잘못된 좌표가 있습니다.' };

      const props = defaultProps(def);
      for (const schema of def.props) {
        const v = Number(comp.props && comp.props[schema.key]);
        if (Number.isFinite(v)) props[schema.key] = clamp(v, schema.min, schema.max);
      }
      validated.push({ type: def.id, x: Math.round(x), y: Math.round(y), props });
    }
    // 킥커를 맵이 직접 관리하는지 (false = 자동 생성 끔). 명시적으로 false 일 때만 저장.
    const cleanAutoKickers = autoKickers === false ? false : undefined;
    return { ok: true, cleanName, cleanHeight, cleanWidth, validated, cleanFinish, cleanAutoKickers };
  }

  /**
   * 유저 맵 저장 (검증 + 하루 생성 제한)
   * @param creatorKey 생성자 식별키(IP 등) — 하루 제한 집계용
   * @returns {{ok: true, id: string} | {ok: false, error: string}}
   */
  save({ name, author, components, height, width, finish, autoKickers } = {}, creatorKey = null) {
    if (this.custom.size >= MAX_CUSTOM_MAPS)
      return { ok: false, error: '서버에 저장된 맵이 너무 많습니다.' };

    // 하루 생성 제한 (대량 생성 남용 방지) — 관리자 설정에서 live
    const dailyLimit = settings.get('mapDailyLimit');
    const dkey = creatorKey ? `${localDate()}|${creatorKey}` : null;
    if (dailyLimit > 0 && dkey) {
      if ((this.dailyByKey.get(dkey) || 0) >= dailyLimit)
        return { ok: false, error: `맵은 하루에 ${dailyLimit}개까지 만들 수 있어요. 내일 다시 시도해주세요.` };
    }

    const v = this._validate({ name, components, height, width, finish, autoKickers });
    if (!v.ok) return v;

    const id = 'm' + Math.random().toString(36).slice(2, 10);
    this.custom.set(id, {
      id,
      name: v.cleanName,
      author: String(author || '익명').trim().slice(0, 12) || '익명',
      height: v.cleanHeight,
      ...(v.cleanWidth !== WORLD.width ? { width: v.cleanWidth } : {}),
      components: v.validated,
      ...(v.cleanFinish ? { finish: v.cleanFinish } : {}),
      ...(v.cleanAutoKickers === false ? { autoKickers: false } : {}),
      createdAt: Date.now(),
    });
    this.persist();

    if (dailyLimit > 0 && dkey) {
      this.dailyByKey.set(dkey, (this.dailyByKey.get(dkey) || 0) + 1);
      if (this.dailyByKey.size > 5000) {
        const today = localDate();
        for (const k of this.dailyByKey.keys()) if (!k.startsWith(today)) this.dailyByKey.delete(k);
      }
    }
    return { ok: true, id };
  }

  /** 관리자: 맵 재편집 — 유저 맵은 덮어쓰기, 기본 맵은 편집본(override) 저장.
   *  기본 맵은 구성요소가 많을 수 있어(예: 클래식 600+) 관리자 편집은 상한을 넉넉히 둔다. */
  update(id, { name, components, height, width, finish, autoKickers } = {}) {
    const v = this._validate({ name, components, height, width, finish, autoKickers }, MAX_COMPONENTS_ADMIN);
    if (!v.ok) return v;

    if (this.custom.has(id)) {
      const existing = this.custom.get(id);
      existing.name = v.cleanName;
      existing.height = v.cleanHeight;
      if (v.cleanWidth !== WORLD.width) existing.width = v.cleanWidth;
      else delete existing.width;
      existing.components = v.validated;
      if (v.cleanFinish) existing.finish = v.cleanFinish;
      else delete existing.finish;
      if (v.cleanAutoKickers === false) existing.autoKickers = false;
      else delete existing.autoKickers;
      existing.updatedAt = Date.now();
      this.persist();
      return { ok: true, id };
    }
    if (this.builtins.has(id)) {
      const base = this.builtins.get(id);
      this.overrides.set(id, {
        id,
        name: v.cleanName,
        author: base.author,
        builtin: true,
        height: v.cleanHeight,
        ...(v.cleanWidth !== WORLD.width ? { width: v.cleanWidth } : {}),
        components: v.validated,
        ...(v.cleanFinish ? { finish: v.cleanFinish } : {}),
        ...(v.cleanAutoKickers === false ? { autoKickers: false } : {}),
        updatedAt: Date.now(),
      });
      this.persistOverrides();
      return { ok: true, id };
    }
    return { ok: false, error: '존재하지 않는 맵입니다.' };
  }

  /** 관리자: 삭제 — 유저 맵은 삭제, 기본 맵은 편집본이 있으면 기본값으로 되돌림 */
  remove(id) {
    if (this.builtins.has(id)) {
      if (this.overrides.delete(id)) {
        this.persistOverrides();
        return { ok: true, reverted: true };
      }
      return { ok: false, error: '기본 맵은 삭제할 수 없어요. (편집만 가능하며, 편집본은 기본값으로 되돌릴 수 있어요)' };
    }
    if (!this.custom.delete(id)) return { ok: false, error: '존재하지 않는 맵입니다.' };
    this.persist();
    return { ok: true };
  }

  /** 관리자: 전체 맵 상세 목록 (기본 맵 먼저, 유저 맵은 최신순) */
  adminList() {
    const builtinRows = [...this.builtins.values()].map((m) => {
      const eff = this.effectiveBuiltin(m);
      return {
        id: m.id,
        name: eff.name,
        author: eff.author,
        count: eff.components.length,
        height: eff.height,
        builtin: true,
        overridden: this.overrides.has(m.id),
        createdAt: 0,
      };
    });
    const customRows = [...this.custom.values()]
      .map((m) => ({
        id: m.id,
        name: m.name,
        author: m.author,
        count: m.components.length,
        height: m.height,
        builtin: false,
        overridden: false,
        createdAt: m.createdAt || 0,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
    return [...builtinRows, ...customRows];
  }
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

module.exports = { MapStore, BOUNDS };
