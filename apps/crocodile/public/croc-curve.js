/**
 * 🦷 잇몸 곡선 → 이빨 배치 (게임 화면과 관리자 편집기가 함께 쓰는 계산기)
 *
 * 관리자 페이지(/dopaman/crocodile)에서 찍은 점들을 부드러운 곡선(Catmull-Rom)으로
 * 잇고, 그 곡선을 '길이 기준'으로 균등 분할해 이빨을 놓는다.
 *   · 첫 이빨은 곡선의 왼쪽 끝, 마지막 이빨은 오른쪽 끝에 고정된다.
 *   · 개수가 몇 개든 그 사이를 똑같은 간격으로 나눈다.
 *   · x 좌표가 아니라 곡선 길이로 나누는 이유: U 자의 옆면(수직에 가까운 구간)에
 *     이빨이 몰리는 것을 막기 위해서다.
 *
 * 이 파일 하나만 고치면 편집기 미리보기와 실제 게임이 항상 같은 결과를 낸다.
 */
(function (root) {
  'use strict';

  var SAMPLES_PER_SEG = 24; // 구간당 샘플 수 (곡선 길이 정밀도)

  /** 옛 형식(2차 베지어 6숫자)도 점 배열로 받아준다 */
  function toPts(arch) {
    if (!Array.isArray(arch) || !arch.length) return [];
    if (typeof arch[0] === 'number') {
      // [x0,y0, cx,cy, x1,y1] → 곡선 위 5점으로 변환
      var a = arch, out = [];
      for (var k = 0; k <= 4; k++) {
        var t = k / 4, u = 1 - t;
        out.push([
          u * u * a[0] + 2 * u * t * a[2] + t * t * a[4],
          u * u * a[1] + 2 * u * t * a[3] + t * t * a[5],
        ]);
      }
      return out;
    }
    return arch.map(function (p) { return [Number(p[0]), Number(p[1])]; });
  }

  /** 점들을 지나는 부드러운 곡선을 촘촘한 꺾은선으로 편다 (Catmull-Rom) */
  function polyline(arch) {
    var P = toPts(arch);
    if (P.length < 2) return P.slice();
    if (P.length === 2) {
      var out2 = [];
      for (var s = 0; s <= SAMPLES_PER_SEG; s++) {
        var t2 = s / SAMPLES_PER_SEG;
        out2.push([P[0][0] + (P[1][0] - P[0][0]) * t2, P[0][1] + (P[1][1] - P[0][1]) * t2]);
      }
      return out2;
    }
    var out = [];
    for (var i = 0; i < P.length - 1; i++) {
      var p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || P[i + 1];
      var last = i === P.length - 2;
      for (var j = 0; j <= SAMPLES_PER_SEG; j++) {
        if (j === SAMPLES_PER_SEG && !last) break; // 이음매 중복 방지
        var t = j / SAMPLES_PER_SEG, t2b = t * t, t3 = t2b * t;
        out.push([
          0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t
            + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2b
            + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t
            + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2b
            + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
        ]);
      }
    }
    return out;
  }

  /** SVG path 문자열 (편집기 미리보기용) */
  function pathD(arch) {
    var L = polyline(arch);
    if (L.length < 2) return '';
    var d = 'M' + L[0][0].toFixed(1) + ',' + L[0][1].toFixed(1);
    for (var i = 1; i < L.length; i++) d += ' L' + L[i][0].toFixed(1) + ',' + L[i][1].toFixed(1);
    return d;
  }

  /** 꺾은선의 누적 길이 */
  function cumLen(L) {
    var c = [0];
    for (var i = 1; i < L.length; i++) c.push(c[i - 1] + Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]));
    return c;
  }

  /** 인덱스로만 결정되는 난수 0~1 (다시 그려도 같은 이빨은 항상 같은 모양) */
  function hash01(i, salt) {
    var x = Math.sin((i + 1) * 127.1 + salt * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  /**
   * 이빨 배치표.
   * @param {object} cfg  {arch, toothH, toothW, tilt, jitter, maxTilt}
   *   tilt   잇몸선 기울기를 얼마나 따라갈지 (0 = 전부 12시 방향)
   *   jitter 이빨마다 무작위로 흔드는 각도(도) — 삐뚤빼뚤한 느낌
   *   maxTilt 12시에서 최대 몇 도까지 벌어질 수 있는지 (30 ≈ 11시/1시)
   * @param {number} n    이빨 개수
   * @returns {Array<{x,y,ang,nx,ny,w,h,sp,t}>}  사진(720×1280) 좌표계
   */
  function layout(cfg, n) {
    var L = polyline(cfg && cfg.arch);
    if (L.length < 2 || !(n > 0)) return [];
    var C = cumLen(L), total = C[C.length - 1] || 1;
    var sp = total / Math.max(1, n - 1); // 곡선을 따라 잰 이빨 간격
    var w0 = Math.max(12, sp * (cfg.toothW == null ? 0.42 : cfg.toothW));
    var tiltK = cfg.tilt == null ? 0 : cfg.tilt;
    var jitter = cfg.jitter == null ? 12 : cfg.jitter;
    var maxTilt = cfg.maxTilt == null ? 30 : cfg.maxTilt;
    var baseH = cfg.toothH == null ? 60 : cfg.toothH;

    var out = [], k = 1;
    for (var i = 0; i < n; i++) {
      var target = n === 1 ? total / 2 : total * (i / (n - 1));
      while (k < C.length - 1 && C[k] < target) k++;
      var seg = C[k] - C[k - 1] || 1, f = (target - C[k - 1]) / seg;
      var a = L[k - 1], b = L[k];
      var x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f;
      // 접선(주변 샘플 차분) → 법선(잇몸 안쪽 = 위)
      var i0 = Math.max(0, k - 2), i1 = Math.min(L.length - 1, k + 1);
      var dx = L[i1][0] - L[i0][0], dy = L[i1][1] - L[i0][1];
      var dl = Math.hypot(dx, dy) || 1;
      var raw = Math.atan2(dy / dl, dx / dl) * 180 / Math.PI - 90; // 접선을 -90° 회전
      while (raw < -180) raw += 360; while (raw > 180) raw -= 360;
      // 이빨 끝은 12시를 향하는 게 기본(tilt 0). 잇몸선 법선을 그대로 따르면
      // U 자 곡률 중심으로 모여 부챗살처럼 눕기 때문에 tilt 로 얼마나 따라갈지 정하고,
      // 대신 이빨마다 무작위로 조금씩 흔들어(jitter) 삐뚤빼뚤하게 보이게 한다.
      var ang = raw * tiltK + (hash01(i, 7) * 2 - 1) * jitter;
      ang = Math.max(-maxTilt, Math.min(maxTilt, ang));
      var rad = ang * Math.PI / 180;
      var t = n === 1 ? 0.5 : i / (n - 1);
      var d = Math.abs(t - 0.5) * 2;      // 0=입 앞쪽(가깝다) … 1=입 안쪽(멀다)
      var persp = 1 - 0.26 * d;           // 안쪽일수록 원근으로 작아진다
      out.push({
        x: x, y: y, t: t, sp: sp, ang: ang,
        nx: Math.sin(rad), ny: -Math.cos(rad),
        w: w0 * persp,
        h: baseH * persp * (0.84 + 0.3 * (((i * 53 + 17) % 11) / 10)), // 개체차
      });
    }
    return out;
  }

  root.CrocCurve = { toPts: toPts, polyline: polyline, pathD: pathD, layout: layout };
})(typeof window !== 'undefined' ? window : globalThis);
