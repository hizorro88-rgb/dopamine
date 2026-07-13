/**
 * 맵 저장소: 기본 제공 맵 + 유저 제작 맵 (data/maps.json 에 영구 저장)
 * 유저가 에디터에서 저장한 맵은 서버의 모든 방에서 선택할 수 있다.
 */

const fs = require('fs');
const path = require('path');
const { WORLD, COMPONENTS, defaultProps } = require('../public/components.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'maps.json');

// 에디터에서 배치 가능한 영역 (위: 공 시작 구역 / 아래: 골인 구역 제외)
// maxY 는 맵 길이에 따라 달라짐: height - 100
const BOUNDS = { minX: 25, maxX: 575, minY: 130 };
const MAX_COMPONENTS = 400;
const MAX_CUSTOM_MAPS = 200;

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

function classicComponents() {
  const comps = [];
  let row = 0;
  for (let y = 170; y <= WORLD.height - 260; y += 62) {
    const offset = row % 2 === 0 ? 0 : 29;
    for (let x = 55 + offset; x <= 545; x += 58) comps.push(peg(x, y));
    row++;
  }
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

  return [...comps, ...funnel()];
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
  // 지그재그 바: /\/\ — 골짜기마다 30px 배수 틈을 둬서 공이 고이지 않는다
  for (let i = 0; i < 3; i++) {
    const x0 = 55 + i * 185;
    wallPath(comps, [[x0, 2720], [x0 + 70, 2630]]);
    wallPath(comps, [[x0 + 85, 2630], [x0 + 155, 2720]]);
  }
  // 마지막 스피너 관문
  comps.push({ type: 'spinner', x: 300, y: 2880, props: { length: 190, speed: 5 } });
  return [...comps, ...funnel(3200)];
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
  return [...comps, ...funnel(2900)];
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
  // 지뢰 격자 (지그재그 배치 — 일직선으로는 절대 못 내려간다)
  const rows = [
    [260, [150, 450]],
    [480, [300]],
    [700, [100, 500]],
    [920, [220, 380]],
    [1140, [300]], // 중앙 대형
    [1360, [130, 470]],
    [1580, [300]],
    [1800, [180, 420]],
    [2020, [80, 520]],
  ];
  for (const [y, xs] of rows) {
    for (const x of xs) comps.push(bomb(x, y));
  }
  // 중앙 대형 지뢰는 더 넓고 강하게
  comps[8].props = { radius: 220, power: 18, respawn: 5 };
  // 🚨 문지기 폭탄 3중 배치: 골인 직전 깔때기 목을 막고 선두를 되받아친다.
  // 터진 뒤 재생성되기 전(게임 시간 6초)에 도착하는 공만 무사히 통과!
  comps.push(bomb(272, 2270, { radius: 170, power: 19, respawn: 6 }));
  comps.push(bomb(328, 2270, { radius: 170, power: 19, respawn: 6 }));
  comps.push(bomb(300, 2320, { radius: 150, power: 17, respawn: 6 }));
  return [...comps, ...funnel(2400)];
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
  // 잔디
  for (let i = 0; i < 5; i++) {
    lineDots(comps, 70 + i * 100, 2010, 120 + i * 100, 1940, 34, 6);
  }
  return [...comps, ...funnel(2400)];
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
  pixelGrid(comps, INVADER_ART_SMALL, { y0: 980, cell: 22, x0: 85, pegSize: 5 });
  pixelGrid(comps, INVADER_ART_SMALL, { y0: 980, cell: 22, x0: 295, pegSize: 5 });
  pixelGrid(comps, INVADER_ART, { y0: 1450, cell: 30, pegSize: 6 });
  // UFO: 돔 범퍼 + 회전 막대
  comps.push({ type: 'bumper', x: 300, y: 1960, props: { size: 18 } });
  comps.push({ type: 'spinner', x: 300, y: 2000, props: { length: 200, speed: 6 } });
  return [...comps, ...funnel(2400)];
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
  // 아기 버섯 세 그루
  for (const [x, y] of [[140, 1780], [300, 1930], [465, 1780]]) {
    arcDots(comps, x, y, 70, -170, -10, 7, 6);
    lineDots(comps, x - 18, y + 15, x - 18, y + 85, 35, 5);
    lineDots(comps, x + 18, y + 15, x + 18, y + 85, 35, 5);
  }
  return [...comps, ...funnel(2400)];
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
  return [...comps, ...funnel(2400)];
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
  return [...comps, ...funnel(3000)];
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
  // 두근두근 바람개비
  comps.push({ type: 'cross', x: 300, y: 1980, props: { length: 130, speed: 5 } });
  return [...comps, ...funnel(2400)];
}

const BUILTIN_MAPS = [
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
  // ── 미니맵 아트 맵: 미니맵으로 보면 그림, 게임에선 핀·범퍼·회전체·폭탄 ──
  {
    id: 'flower',
    name: '🌼 활짝 핀 꽃',
    author: '기본 맵',
    builtin: true,
    height: 2400,
    components: flowerComponents(),
  },
  {
    id: 'invader',
    name: '👾 픽셀 인베이더',
    author: '기본 맵',
    builtin: true,
    height: 2400,
    components: invaderComponents(),
  },
  {
    id: 'mushroom',
    name: '🍄 대왕 버섯',
    author: '기본 맵',
    builtin: true,
    height: 2400,
    components: mushroomComponents(),
  },
  {
    id: 'skull',
    name: '💀 해적 해골',
    author: '기본 맵',
    builtin: true,
    height: 2400,
    components: skullComponents(),
  },
  {
    id: 'rocket',
    name: '🚀 로켓 발사',
    author: '기본 맵',
    builtin: true,
    height: 3000,
    components: rocketComponents(),
  },
  {
    id: 'hearts',
    name: '❤️ 하트 폭포',
    author: '기본 맵',
    builtin: true,
    height: 2400,
    components: heartsComponents(),
  },
  {
    id: 'minefield',
    name: '💣 지뢰밭',
    author: '기본 맵',
    builtin: true,
    height: 2400,
    components: minefieldComponents(),
  },
  // ── 코스형 맵: 벽에 부딪히며 좌우로 꺾여 내려간다 ──
  {
    id: 'canyon',
    name: '🐍 지그재그 협곡',
    author: '기본 맵',
    builtin: true,
    height: 3200,
    components: canyonComponents(),
  },
  {
    id: 'cascade',
    name: '🌪 깔때기 폭포',
    author: '기본 맵',
    builtin: true,
    height: 2900,
    components: cascadeComponents(),
  },
];

// ── 저장소 ──────────────────────────────────────────────

class MapStore {
  constructor() {
    this.builtins = new Map(BUILTIN_MAPS.map((m) => [m.id, m]));
    this.custom = new Map();
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
  }

  persist() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([...this.custom.values()], null, 2));
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
    });
    return [...this.builtins.values(), ...this.custom.values()].map(meta);
  }

  get(id) {
    return this.builtins.get(id) || this.custom.get(id) || null;
  }

  /**
   * 유저 맵 저장 (검증 포함)
   * @returns {{ok: true, id: string} | {ok: false, error: string}}
   */
  save({ name, author, components, height } = {}) {
    const cleanName = String(name || '').trim().slice(0, 20);
    if (!cleanName) return { ok: false, error: '맵 이름을 입력해주세요.' };
    if (!Array.isArray(components) || components.length === 0)
      return { ok: false, error: '구성요소를 1개 이상 배치해주세요.' };
    if (components.length > MAX_COMPONENTS)
      return { ok: false, error: `구성요소는 최대 ${MAX_COMPONENTS}개까지 가능합니다.` };
    if (this.custom.size >= MAX_CUSTOM_MAPS)
      return { ok: false, error: '서버에 저장된 맵이 너무 많습니다.' };

    // 맵 길이: 허용 범위로 잘라서 저장
    const h = Number(height);
    const cleanHeight = Number.isFinite(h)
      ? Math.round(clamp(h, WORLD.minHeight, WORLD.maxHeight) / 50) * 50
      : WORLD.height;
    const maxY = cleanHeight - 100;

    const validated = [];
    for (const comp of components) {
      const def = COMPONENTS[comp && comp.type];
      if (!def) return { ok: false, error: `알 수 없는 구성요소: ${comp && comp.type}` };

      const x = clamp(Number(comp.x), BOUNDS.minX, BOUNDS.maxX);
      const y = clamp(Number(comp.y), BOUNDS.minY, maxY);
      if (!Number.isFinite(x) || !Number.isFinite(y))
        return { ok: false, error: '잘못된 좌표가 있습니다.' };

      // props 는 스키마에 정의된 키만, min/max 로 잘라서 저장
      const props = defaultProps(def);
      for (const schema of def.props) {
        const v = Number(comp.props && comp.props[schema.key]);
        if (Number.isFinite(v)) props[schema.key] = clamp(v, schema.min, schema.max);
      }
      validated.push({ type: def.id, x: Math.round(x), y: Math.round(y), props });
    }

    const id = 'm' + Math.random().toString(36).slice(2, 10);
    this.custom.set(id, {
      id,
      name: cleanName,
      author: String(author || '익명').trim().slice(0, 12) || '익명',
      height: cleanHeight,
      components: validated,
      createdAt: Date.now(),
    });
    this.persist();
    return { ok: true, id };
  }
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

module.exports = { MapStore, BOUNDS };
