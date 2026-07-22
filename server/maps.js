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

  return [...tileY(comps, 2, 2250), ...funnel()];
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

/** ◇ 다이아몬드(마름모) 외곽선 — 네 꼭짓점을 벽으로 이어 그린다 */
function diamond(comps, x, y, d) {
  wallPath(comps, [
    [x, y - d],
    [x + d, y],
    [x, y + d],
    [x - d, y],
    [x, y - d],
  ]);
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
  return [...tileY(comps, 2, 3000), ...funnel(6400)];
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
  return [...tileY(comps, 2, 2650), ...funnel(5800)];
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
  // 잔디
  for (let i = 0; i < 5; i++) {
    lineDots(comps, 70 + i * 100, 2010, 120 + i * 100, 1940, 34, 6);
  }
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
  // UFO: 돔 범퍼 + 회전 막대
  comps.push({ type: 'bumper', x: 300, y: 1960, props: { size: 18 } });
  comps.push({ type: 'spinner', x: 300, y: 2000, props: { length: 200, speed: 6 } });
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
  // 아기 버섯 세 그루
  for (const [x, y] of [[140, 1780], [300, 1930], [465, 1780]]) {
    arcDots(comps, x, y, 70, -170, -10, 7, 6);
    lineDots(comps, x - 18, y + 15, x - 18, y + 85, 35, 5);
    lineDots(comps, x + 18, y + 15, x + 18, y + 85, 35, 5);
  }
  return [...tileY(comps, 2, 2250), ...funnel(4800)];
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
  return [...tileY(comps, 2, 2250), ...funnel(4800)];
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
  // 두근두근 바람개비
  comps.push({ type: 'cross', x: 300, y: 1980, props: { length: 130, speed: 5 } });
  return [...tileY(comps, 2, 2250), ...funnel(4800)];
}

// 🌀 웜홀 정거장: 포탈로 옆·아래·위로 워프 — 낙하가 비선형이 된다
function wormholeComponents() {
  const comps = [];
  const portal = (x, y, channel) => ({ type: 'portal', x, y, props: { channel } });

  // 1구간: 핀 밭 + 좌우 워프 (ch1 — 왼쪽 포탈에 빨려들면 오른쪽에서 튀어나온다)
  pegRow(comps, 220);
  pegRow(comps, 290, 27);
  comps.push(portal(70, 500, 1));
  comps.push(portal(530, 500, 1));
  comps.push({ type: 'wall', x: 150, y: 420, props: { length: 180, angle: 30 } });
  lineDots(comps, 300, 440, 440, 410, 40, 6);

  // 2구간: 지름길 사다리 (ch2 — 760에서 타면 2150으로 순간 강하!)
  comps.push(portal(300, 760, 2));
  ringDots(comps, 300, 760, 60, 10, 6);
  pegRow(comps, 1000);
  pegRow(comps, 1070, 27);
  comps.push({ type: 'cross', x: 300, y: 1280, props: { length: 130, speed: 4 } });
  comps.push({ type: 'spinner', x: 170, y: 1550, props: { length: 150, speed: -5 } });
  comps.push({ type: 'spinner', x: 430, y: 1550, props: { length: 150, speed: 5 } });
  pegRow(comps, 1800, 27);
  comps.push({ type: 'bumper', x: 300, y: 1980, props: { size: 20 } });
  comps.push(portal(300, 2150, 2)); // ch2 출구

  // 3구간: 저주의 뱀 포탈 (ch3 — 2750에서 밟으면 1000으로 되돌아간다!)
  pegRow(comps, 2400);
  pegRow(comps, 2470, 27);
  comps.push({ type: 'bomb', x: 100, y: 2600, props: { radius: 140, power: 14, respawn: 6 } });
  comps.push({ type: 'bomb', x: 500, y: 2600, props: { radius: 140, power: 14, respawn: 6 } });
  comps.push(portal(300, 2750, 3)); // 🐍 입구 — 가운데를 지키는 함정
  comps.push({ type: 'wall', x: 150, y: 2680, props: { length: 200, angle: 25 } });
  comps.push({ type: 'wall', x: 450, y: 2680, props: { length: 200, angle: -25 } });
  comps.push(portal(450, 1000, 3)); // 🐍 출구 — 위쪽으로 강제 소환

  // 4구간: 좌우 워프 한 번 더 (ch4) + 회전 관문
  comps.push(portal(80, 3250, 4));
  comps.push(portal(520, 3250, 4));
  lineDots(comps, 200, 3200, 400, 3250, 44, 6);
  comps.push({ type: 'cross', x: 170, y: 3550, props: { length: 120, speed: -4 } });
  comps.push({ type: 'cross', x: 430, y: 3550, props: { length: 120, speed: 4 } });

  // 5구간: 마지막 핀 밭 + 스피너
  pegRow(comps, 3850);
  pegRow(comps, 3920, 27);
  comps.push({ type: 'spinner', x: 300, y: 4200, props: { length: 200, speed: 5 } });
  pegRow(comps, 4450, 27);

  return [...comps, ...funnel(4800)];
}

// 🎢 트램펄린 산맥: 경사로를 타고 내려와 점프 패드로 벽을 넘는다 — 위아래로 출렁이는 낙하
function trampolineComponents() {
  const comps = [];
  const jumper = (x, y, props = {}) => ({
    type: 'jumper',
    x,
    y,
    props: { width: 110, power: 17, angle: 0, ...props },
  });

  // 각 구간: 경사로 → 골짜기의 점프 패드 → 낮은 장벽을 넘어 다음 구간 (좌우 교대)
  for (let k = 0; k < 3; k++) {
    const y0 = 320 + k * 1300;
    if (k % 2 === 0) {
      // 왼쪽에서 오른쪽 아래로 흐르는 경사
      wallPath(comps, [[25, y0], [400, y0 + 320]]);
      comps.push(jumper(460, y0 + 350, { power: 20, angle: 12 })); // 위로 높이, 살짝 오른쪽
      wallPath(comps, [[515, y0 + 210], [515, y0 + 360]]); // 낮은 장벽 — 폴짝 넘는다
      lineDots(comps, 120, y0 + 120, 300, y0 + 60, 45, 6);
      comps.push({ type: 'bumper', x: 100, y: y0 + 500, props: { size: 16 } });
    } else {
      wallPath(comps, [[575, y0], [200, y0 + 320]]);
      comps.push(jumper(140, y0 + 350, { power: 20, angle: -12 })); // 위로 높이, 살짝 왼쪽
      wallPath(comps, [[85, y0 + 210], [85, y0 + 360]]);
      lineDots(comps, 300, y0 + 60, 480, y0 + 120, 45, 6);
      comps.push({ type: 'bumper', x: 500, y: y0 + 500, props: { size: 16 } });
    }
    // 구간 사이 회전체 (마지막 구간 뒤는 트램펄린 밭이 있으므로 생략)
    if (k < 2) {
      comps.push({
        type: k % 2 === 0 ? 'cross' : 'spinner',
        x: 300,
        y: y0 + 850,
        props: { length: 140, speed: k % 2 === 0 ? 4 : -5 },
      });
    }
  }

  // 마지막 구간: 트램펄린 두 대 — 가운데 틈 쪽으로 기울어져 통통 튀다 빠져나간다
  pegRow(comps, 4150, 27);
  comps.push(jumper(150, 4400, { width: 110, power: 11, angle: 15 }));
  comps.push(jumper(450, 4400, { width: 110, power: 11, angle: -15 }));

  return [...comps, ...funnel(4800)];
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

  // ── 중상단: 스피너 쌍 + 사이드 슬링샷 범퍼 ──
  S(165, 690, 150, 4);
  S(435, 690, 150, -4);
  B(90, 800, 16);
  B(510, 800, 16);
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

  // ── 하단 플레이필드: 범퍼·핀 밭 + 회전체 ──
  B(150, 1780, 18);
  B(450, 1780, 18);
  S(300, 1800, 140, -4);
  pegRow(comps, 1960);
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

// 🏺 욕망의 항아리: 부드러운 항아리 실루엣.
//   가운데로 정확히 흘러든 공만 중앙 슈트를 통해 골인하고,
//   양옆으로 새어나간 공은 회전 막대(스쿱)에 맞아 다시 위로 올라간다.
function jarComponents() {
  const H = 2800;
  const CX = 300;
  const comps = [];
  const mir = (pts) => pts.map(([x, y]) => [600 - x, y]);

  // ── 부드러운 항아리 실루엣 ──
  // 중심에서의 반너비(halfWidth)를 y별 키프레임으로 두고 코사인 보간해 촘촘히 샘플 →
  // wallPath 가 매끄러운 곡선처럼 이어 그린다.
  const keys = [
    [232, 266], // 넓은 아가리
    [430, 250], // 어깨
    [720, 214], // 몸통 상부
    [1030, 150], // 좁아지는 목
    [1330, 92], // 허리(가장 좁음) — 관문
    [1640, 232], // 배 상부(불룩)
    [1980, 252], // 배 최대
    [2280, 210], // 배 하부
    [2470, 158], // 바닥으로 좁힘
  ];
  const halfAt = (y) => {
    if (y <= keys[0][0]) return keys[0][1];
    if (y >= keys[keys.length - 1][0]) return keys[keys.length - 1][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [y0, w0] = keys[i];
      const [y1, w1] = keys[i + 1];
      if (y >= y0 && y <= y1) {
        const t = (y - y0) / (y1 - y0);
        const s = (1 - Math.cos(t * Math.PI)) / 2; // 코사인 보간(양끝이 부드럽다)
        return w0 + (w1 - w0) * s;
      }
    }
    return keys[keys.length - 1][1];
  };
  const leftPts = [];
  for (let y = keys[0][0]; y <= keys[keys.length - 1][0]; y += 45) {
    leftPts.push([Math.round(CX - halfAt(y)), y]);
  }
  wallPath(comps, leftPts);
  wallPath(comps, mir(leftPts));

  // 상단 곡선 뚜껑선
  comps.push({ type: 'wall', x: CX, y: 240, props: { length: 150, angle: 0, curve: 62 } });

  // ◇ 시안 다이아 클러스터 (장식 겸 산란)
  diamond(comps, CX, 560, 44);
  diamond(comps, 206, 815, 40);
  diamond(comps, 394, 815, 40);
  diamond(comps, CX, 1055, 44);

  // 허리 관문: 중앙 회전 십자 — 좁은 목에서 순위가 뒤섞인다
  comps.push({ type: 'cross', x: CX, y: 1330, props: { length: 118, speed: 3 } });

  // ── 배(하부) 스쿱 회전 막대: 양옆으로 퍼진 공을 다시 위로 퍼올린다 ──
  comps.push({ type: 'spinner', x: 152, y: 1980, props: { length: 150, speed: 6 } }); // 좌(시계)
  comps.push({ type: 'spinner', x: 448, y: 1980, props: { length: 150, speed: -6 } }); // 우(반시계)
  comps.push({ type: 'bumper', x: CX, y: 1900, props: { size: 18 } }); // 중앙 범퍼 — 좌우로 튕겨 갈림

  // ── 바닥부 ──
  // 중앙: 좁은 골인 슈트. 그 입구로 모으는 짧은 깔때기.
  // 양옆: 스쿱 스피너가 위로 퍼올린다. 못 맞은 공은 열린 아래로 빠져 맵 위로 순환(끼임 없음).

  // 중앙 골인 슈트 (좁은 수직 통로) — 여기로 정확히 들어온 공만 골인
  comps.push({ type: 'wall', x: 256, y: 2640, props: { length: 175, angle: 90 } });
  comps.push({ type: 'wall', x: 344, y: 2640, props: { length: 175, angle: 90 } });
  // 슈트 입구로 모으는 짧은 깔때기 (가운데로 온 공만 진입)
  comps.push({ type: 'wall', x: 224, y: 2512, props: { length: 96, angle: 38 } });
  comps.push({ type: 'wall', x: 376, y: 2512, props: { length: 96, angle: -38 } });
  // 양옆 스쿱 스피너 — 옆으로 온 공을 위로 퍼올린다
  comps.push({ type: 'spinner', x: 158, y: 2510, props: { length: 152, speed: 7 } });
  comps.push({ type: 'spinner', x: 442, y: 2510, props: { length: 152, speed: -7 } });

  return comps; // 자체 중앙 슈트로 골인 (funnel 미사용)
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
  dam(750, 4);

  // ── 장애물: 닫힌 도넛 + 범퍼 + 스피너 (도넛 앞뒤로 범퍼가 공을 계속 튕겨 정체 방지) ──
  comps.push({ type: 'bumper', x: 150, y: 900, props: { size: 18 } });
  comps.push({ type: 'bumper', x: 450, y: 900, props: { size: 18 } });
  ring(300, 960, 52);
  comps.push({ type: 'spinner', x: 300, y: 1120, props: { length: 170, speed: 4 } });

  // ── 두 번째 벽 (12회) ──
  guide(1290);
  dam(1370, 6);

  // ── 링 터널: 도넛 세 개(한 줄, 넉넉한 간격) 사이를 지난다 (앞에 범퍼로 속도 부여) ──
  ring(200, 1620, 52);
  comps.push({ type: 'cross', x: 300, y: 1860, props: { length: 120, speed: -4 } });

  // ── 세 번째 벽 (14회) ──
  guide(2060);
  dam(2140, 8);

  // ── 핀 + 범퍼 통통 구간 (공을 가두지 않고 튕겨 흐르게) ──
  lineDots(comps, 90, 2380, 510, 2380, 58, 6);
  comps.push({ type: 'bumper', x: 150, y: 2500, props: { size: 18 } });
  comps.push({ type: 'bumper', x: 300, y: 2470, props: { size: 20 } });
  comps.push({ type: 'bumper', x: 450, y: 2500, props: { size: 18 } });
  comps.push({ type: 'cross', x: 300, y: 2630, props: { length: 110, speed: 4 } });

  // ── 네 번째 벽 (가장 튼튼, 16회) ──
  guide(2720);
  dam(2800, 10);

  // ── 링 무리(한 줄) + 스피너 관문 ──
  ring(400, 3040, 52);
  comps.push({ type: 'spinner', x: 190, y: 3260, props: { length: 150, speed: 5 } });
  comps.push({ type: 'spinner', x: 410, y: 3260, props: { length: 150, speed: -5 } });

  // ── 다섯 번째 벽 (마지막 관문, 12회) ──
  guide(3480);
  dam(3560, 6);

  // ── 피날레: 링 + 십자 + 핀 ──
  ring(300, 3820, 54);
  comps.push({ type: 'cross', x: 300, y: 4040, props: { length: 130, speed: 4 } });
  lineDots(comps, 90, 4230, 510, 4230, 64, 6);

  return [...comps, ...funnel(H)];
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
    id: 'jar',
    name: '🏺 욕망의 항아리',
    author: '기본 맵',
    builtin: true,
    height: 2800,
    // 가운데 좁은 슈트로 들어온 공만 골인 (양옆으로 새면 스쿱 막대로 되돌아간다)
    finish: { x: 300, y: 2745, width: 110, height: 46 },
    components: jarComponents(),
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
  {
    id: 'wormhole',
    name: '🌀 웜홀 정거장',
    author: '기본 맵',
    builtin: true,
    height: 4800,
    components: wormholeComponents(),
  },
  {
    id: 'trampoline',
    name: '🎢 트램펄린 산맥',
    author: '기본 맵',
    builtin: true,
    height: 4800,
    components: trampolineComponents(),
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
