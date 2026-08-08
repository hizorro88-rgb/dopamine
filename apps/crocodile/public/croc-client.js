/* 🐊 악어 룰렛 — 클라이언트
 * ────────────────────────────────────────────────────────────
 * 애니메이션이 이 앱의 핵심. 모든 '드라마' 연출은 서버가 결정해 방 전원에게
 * 동기 전송되므로, 여기서는 서버 이벤트를 받아 '똑같은' 연출을 재생만 한다.
 *  - JawController: 위턱 각도를 rAF 로 부드럽게 제어(숨쉬기 + 극적 연출 겸용)
 *  - 인트로: 물 밑에서 스믈스믈 떠올라 입을 '악!' 벌리며 시작
 *  - 드라마: 침 뚝뚝(drool) / 움찔(twitch) / 확 다물다 멈춤(chomp-fake) / 악어새(bird)
 *  - 물기(bite): 느린 긴장 → 망설임 → 쾅! (화면 흔들림 + 붉은 플래시)
 */
(function () {
  'use strict';
  /* global io, qrcode */

  // ── 소켓 (전용 네임스페이스) ──
  const socket = io('/croc');

  // ── 재접속 토큰 ──
  let token = localStorage.getItem('croc-token');
  if (!token) {
    token = (crypto.randomUUID && crypto.randomUUID()) ||
      Date.now().toString(36) + Math.random().toString(36).slice(2);
    localStorage.setItem('croc-token', token);
  }

  // ── DOM 헬퍼 ──
  const $ = (sel) => document.querySelector(sel);
  const el = (id) => document.getElementById(id);
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ── 상태 ──
  const state = {
    screen: 'home',
    code: null,
    myId: null,        // 소켓 id (연결 시 채움)
    role: null,        // 'player' | 'spectator'
    room: null,        // 최신 croc:room 페이로드
    myTurn: false,
    busy: false,       // 애니메이션 진행 중 입력 잠금
    teeth: 12,
    character: 'crocodile',
    sound: localStorage.getItem('croc-sound') !== '0',
  };

  // ── 무대 지오메트리(SVG viewBox 0..600 x 0..1000, 정면 악어) ──
  // 위턱은 '회전'이 아니라 '수직 이동'으로 입을 벌린다(정면 악어). 값은 위로(-) 이동 px.
  const JAW = { closed: 0, bite: 16, idle: -172, wide: -210, fake: -34 };
  const TEETH_LEFT = 120, TEETH_RIGHT = 480; // 이빨 배치 x 범위
  const GUM_Y = 596;      // 아래 이빨 뿌리 y (위로 솟음)
  const TOOTH_H = 54;     // 이빨 높이
  const UPPER_Y = 600;    // 위 이빨 뿌리 y (아래로 향함)

  // ═══════════════════════════════════════════════════════════
  //  오디오 (WebAudio 로 간단한 효과음 — 파일 없이 합성)
  // ═══════════════════════════════════════════════════════════
  let actx = null;
  function audioReady() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { actx = null; } }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }
  function tone(freq, dur, type, gain, slideTo) {
    if (!state.sound) return;
    const ac = audioReady(); if (!ac) return;
    const t = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.18, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ac.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, gain) {
    if (!state.sound) return;
    const ac = audioReady(); if (!ac) return;
    const n = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ac.createBufferSource(); src.buffer = buf;
    const g = ac.createGain(); g.gain.value = gain || 0.15;
    src.connect(g).connect(ac.destination); src.start();
  }
  const sfx = {
    tick: () => tone(520, 0.08, 'square', 0.09),
    press: () => tone(300, 0.1, 'sine', 0.14, 180),
    drip: () => { tone(900, 0.14, 'sine', 0.12, 300); },
    tension: () => tone(160, 0.5, 'sawtooth', 0.08, 90),
    fake: () => { tone(120, 0.18, 'sawtooth', 0.22, 60); noise(0.12, 0.12); },
    bird: () => { tone(1400, 0.09, 'sine', 0.1, 1800); setTimeout(() => tone(1700, 0.09, 'sine', 0.1, 2100), 90); },
    chomp: () => { noise(0.18, 0.35); tone(90, 0.25, 'square', 0.28, 40); },
    roar: () => { tone(110, 0.5, 'sawtooth', 0.25, 70); noise(0.4, 0.18); },
    win: () => { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.18, 'triangle', 0.16), i * 90)); },
    splash: () => noise(0.25, 0.12),
  };

  // ═══════════════════════════════════════════════════════════
  //  JawController — 위턱 각도 부드럽게 제어 (숨쉬기 + 극적 연출)
  // ═══════════════════════════════════════════════════════════
  // angle 은 이제 위턱의 '수직 이동량(px, 위로 -)'을 뜻한다. (정면 악어 입 벌리기)
  const Jaw = {
    node: null,
    angle: JAW.closed,   // 현재 이동량
    breathe: false,
    _from: JAW.closed, _to: JAW.closed, _t0: 0, _dur: 0, _ease: null, _resolve: null,
    init(node) {
      this.node = node;
      node.style.transformBox = 'view-box';
      this.setInstant(JAW.closed);
    },
    get offset() { return this.angle; }, // 파티클 위치 보정용 (현재 위턱 이동량)
    setInstant(a) { this.angle = a; this._to = a; this._from = a; this._dur = 0; this._apply(this.angle); },
    to(a, dur, ease) {
      this._from = this.angle; this._to = a; this._dur = dur; this._t0 = performance.now();
      this._ease = ease || easeInOutCubic;
      return new Promise((res) => { this._resolve = res; });
    },
    _apply(display) { if (this.node) this.node.style.transform = 'translateY(' + display.toFixed(2) + 'px)'; },
    tick(now) {
      if (this._dur > 0) {
        const p = Math.min(1, (now - this._t0) / this._dur);
        this.angle = this._from + (this._to - this._from) * this._ease(p);
        if (p >= 1) { this._dur = 0; const r = this._resolve; this._resolve = null; if (r) r(); }
      }
      let display = this.angle;
      if (this.breathe && this._dur === 0) display += Math.sin(now / 640) * 5 - 2; // 숨쉬기(위아래 살랑)
      this._apply(display);
    },
  };
  function easeInOutCubic(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
  function easeOutBack(p) { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }
  function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3); }

  // rAF 루프 (턱 + 씬 미세 애니)
  let crocNode = null, birdNode = null;
  function rafLoop(now) {
    Jaw.tick(now);
    // 물결(수면 가장자리) 살짝 흔들기
    const edge = el('waterEdge');
    if (edge) edge.setAttribute('transform', 'translate(0,' + (Math.sin(now / 700) * 3).toFixed(2) + ')');
    requestAnimationFrame(rafLoop);
  }

  // ═══════════════════════════════════════════════════════════
  //  파티클 (SVG viewBox 좌표) — 침방울 / 물보라 / 컨페티
  // ═══════════════════════════════════════════════════════════
  let particleLayer = null;
  function ensureParticleLayer() {
    if (particleLayer && particleLayer.isConnected) return particleLayer;
    const scene = el('scene');
    particleLayer = document.createElementNS(SVGNS, 'g');
    particleLayer.setAttribute('id', 'particles');
    scene.appendChild(particleLayer);
    return particleLayer;
  }
  function drool(x, y) {
    const layer = ensureParticleLayer();
    const d = document.createElementNS(SVGNS, 'ellipse');
    d.setAttribute('cx', x); d.setAttribute('cy', y);
    d.setAttribute('rx', 5); d.setAttribute('ry', 7);
    d.setAttribute('fill', 'rgba(180,230,255,0.85)');
    layer.appendChild(d);
    const fall = Math.max(40, 700 - y) + Math.random() * 40;
    const anim = d.animate(
      [
        { transform: 'translateY(0) scaleY(1)', opacity: 0.2 },
        { transform: 'translateY(10px) scaleY(1.4)', opacity: 0.9, offset: 0.2 },
        { transform: 'translateY(' + fall + 'px) scaleY(1)', opacity: 0.9, offset: 0.9 },
        { transform: 'translateY(' + fall + 'px) scaleY(0.2)', opacity: 0 },
      ],
      { duration: 700 + Math.random() * 400, easing: 'cubic-bezier(.5,0,.9,.5)' }
    );
    anim.onfinish = () => d.remove();
  }
  function splash(x, y, n, color) {
    const layer = ensureParticleLayer();
    for (let i = 0; i < (n || 12); i++) {
      const p = document.createElementNS(SVGNS, 'circle');
      const r = 3 + Math.random() * 5;
      p.setAttribute('cx', x); p.setAttribute('cy', y); p.setAttribute('r', r);
      p.setAttribute('fill', color || 'rgba(150,220,235,0.9)');
      layer.appendChild(p);
      const ang = Math.PI * (0.15 + Math.random() * 0.7) * -1; // 위쪽으로
      const spd = 60 + Math.random() * 120;
      const dx = Math.cos(ang) * spd * (Math.random() < 0.5 ? 1 : -1);
      const dy = Math.sin(ang) * spd - 40;
      const anim = p.animate(
        [
          { transform: 'translate(0,0)', opacity: 1 },
          { transform: 'translate(' + dx + 'px,' + (dy + 90) + 'px)', opacity: 0 },
        ],
        { duration: 600 + Math.random() * 400, easing: 'cubic-bezier(.3,.7,.6,1)' }
      );
      anim.onfinish = () => p.remove();
    }
  }
  function confetti() {
    const layer = ensureParticleLayer();
    const colors = ['#ffd24a', '#ff6a9e', '#63d29a', '#5aa2e8', '#a879e8', '#f28e5a'];
    for (let i = 0; i < 90; i++) {
      const c = document.createElementNS(SVGNS, 'rect');
      const w = 9 + Math.random() * 9, h = 6 + Math.random() * 7;
      const x = Math.random() * 600;
      c.setAttribute('x', x); c.setAttribute('y', -20);
      c.setAttribute('width', w); c.setAttribute('height', h);
      c.setAttribute('fill', colors[i % colors.length]);
      c.setAttribute('rx', 2);
      layer.appendChild(c);
      const dx = (Math.random() - 0.5) * 180;
      const rot = (Math.random() - 0.5) * 1000;
      const anim = c.animate(
        [
          { transform: 'translate(0,0) rotate(0)', opacity: 1 },
          { transform: 'translate(' + dx + 'px,' + (1000 + Math.random() * 120) + 'px) rotate(' + rot + 'deg)', opacity: 1, offset: 0.85 },
          { transform: 'translate(' + dx + 'px,1120px) rotate(' + rot + 'deg)', opacity: 0 },
        ],
        { duration: 2400 + Math.random() * 1400, easing: 'cubic-bezier(.3,.6,.7,1)', delay: Math.random() * 700 }
      );
      anim.onfinish = () => c.remove();
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  이빨 렌더 & 위치 계산
  // ═══════════════════════════════════════════════════════════
  function toothX(i, n) {
    if (n <= 1) return (TEETH_LEFT + TEETH_RIGHT) / 2;
    return TEETH_LEFT + (TEETH_RIGHT - TEETH_LEFT) * (i / (n - 1));
  }
  function toothArcY(i, n, baseY, amp) {
    const t = n <= 1 ? 0.5 : i / (n - 1);
    return baseY - Math.sin(Math.PI * t) * (amp || 26);
  }
  // ── SVG 헬퍼 ──
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function scuteBump(parent, x, y, rx, ry) {
    if (!parent) return;
    parent.appendChild(svgEl('ellipse', { cx: x, cy: y + 2.5, rx, ry, fill: 'var(--skin-shadow)', opacity: 0.6 }));
    parent.appendChild(svgEl('ellipse', { cx: x, cy: y - 1.5, rx: rx * 0.78, ry: ry * 0.7, fill: 'var(--skin-1)', opacity: 0.82 }));
  }
  function capsule(cx, cy, len, thick, rot, fill) {
    const g = svgEl('g', { transform: `translate(${cx},${cy}) rotate(${rot})` });
    g.appendChild(svgEl('rect', { x: -len / 2, y: -thick / 2, width: len, height: thick, rx: thick / 2, fill, stroke: 'var(--skin-edge)', 'stroke-width': 3 }));
    return g;
  }
  function hornSpike(cx, cy, rot) {
    const g = svgEl('g', { transform: `translate(${cx},${cy}) rotate(${rot})` });
    g.appendChild(svgEl('path', { d: 'M-15,12 L0,-56 L15,12 Q0,2 -15,12 Z', fill: 'var(--skin-2)', stroke: 'var(--skin-edge)', 'stroke-width': 3 }));
    g.appendChild(svgEl('path', { d: 'M-6,8 L0,-40 L4,8 Z', fill: 'var(--skin-shadow)', opacity: 0.5 }));
    return g;
  }

  // ── 캐릭터별 눈 ──
  function eyeSlit(g, cx, cy, rot) { // 악어: 호박색 세로동공
    const e = svgEl('g', { class: 'eye', transform: `translate(${cx},${cy}) rotate(${rot})` });
    e.appendChild(svgEl('ellipse', { cx: 0, cy: 4, rx: 42, ry: 36, fill: 'url(#bodyGrad)', stroke: 'var(--skin-edge)', 'stroke-width': 4 }));
    e.appendChild(svgEl('path', { d: 'M-36,2 Q0,-20 36,2 Q0,16 -36,2 Z', fill: '#efe0a6' }));
    e.appendChild(svgEl('ellipse', { cx: 0, cy: 1, rx: 17, ry: 15, fill: 'url(#irisGrad)' }));
    e.appendChild(svgEl('ellipse', { class: 'pupil', cx: 0, cy: 1, rx: 4, ry: 13, fill: '#0a0a05' }));
    e.appendChild(svgEl('circle', { cx: 6, cy: -6, r: 3.4, fill: '#fff', opacity: 0.9 }));
    e.appendChild(svgEl('path', { class: 'lid', d: 'M-38,2 Q0,-22 38,2 L38,-26 L-38,-26 Z', fill: 'var(--skin-2)', stroke: 'var(--skin-edge)', 'stroke-width': 3 }));
    g.appendChild(e);
  }
  function eyeBlack(g, cx, cy, rot) { // 상어: 무표정 검은 눈
    const e = svgEl('g', { class: 'eye', transform: `translate(${cx},${cy}) rotate(${rot})` });
    e.appendChild(svgEl('ellipse', { cx: 0, cy: 0, rx: 30, ry: 25, fill: 'var(--skin-2)', stroke: 'var(--skin-edge)', 'stroke-width': 4 }));
    e.appendChild(svgEl('path', { d: 'M-25,0 Q0,-17 25,0 Q0,15 -25,0 Z', fill: '#090c10' }));
    e.appendChild(svgEl('circle', { class: 'pupil', cx: 0, cy: 0, r: 7, fill: '#04060a' }));
    e.appendChild(svgEl('circle', { cx: 7, cy: -5, r: 3, fill: '#fff', opacity: 0.45 }));
    e.appendChild(svgEl('path', { class: 'lid', d: 'M-27,0 Q0,-17 27,0 L27,-20 L-27,-20 Z', fill: 'var(--skin-1)', stroke: 'var(--skin-edge)', 'stroke-width': 3 }));
    g.appendChild(e);
  }
  function eyePredator(g, cx, cy, rot, iris) { // 티라노/몬스터: 사나운 눈
    const e = svgEl('g', { class: 'eye', transform: `translate(${cx},${cy}) rotate(${rot})` });
    e.appendChild(svgEl('ellipse', { cx: 0, cy: 2, rx: 37, ry: 31, fill: 'url(#bodyGrad)', stroke: 'var(--skin-edge)', 'stroke-width': 4 }));
    e.appendChild(svgEl('path', { d: 'M-31,-2 Q0,-18 31,-2 Q0,15 -31,-2 Z', fill: '#f7ead0' }));
    e.appendChild(svgEl('circle', { cx: 0, cy: -1, r: 15, fill: iris }));
    e.appendChild(svgEl('ellipse', { class: 'pupil', cx: 0, cy: -1, rx: 5, ry: 13, fill: '#0a0705' }));
    e.appendChild(svgEl('circle', { cx: 6, cy: -6, r: 3.3, fill: '#fff', opacity: 0.9 }));
    e.appendChild(svgEl('path', { class: 'lid', d: 'M-33,-2 Q0,-18 33,-2 L33,-22 L-33,-22 Z', fill: 'var(--skin-2)', stroke: 'var(--skin-edge)', 'stroke-width': 3 }));
    g.appendChild(e);
  }

  // ── 캐릭터 정의 (형태/눈/특징/이빨이 전부 다름) ──
  const CREATURES = {
    crocodile: {
      upper: 'M62,612 Q42,470 132,428 Q210,400 300,398 Q390,400 468,428 Q558,470 538,612 Q300,556 62,612 Z',
      lower: 'M66,600 Q300,548 534,600 Q580,678 550,802 Q300,880 50,802 Q20,678 66,600 Z',
      mouthFill: 'url(#mouthGrad)', tongue: '#7d1424', dorsal: null, texU: 0.18, texL: 0.16,
      tooth: { style: 'conic', wMul: 0.58, hMul: 1.0 },
      buildEyes(g) { eyeSlit(g, 206, 440, -12); eyeSlit(g, 394, 440, 12); },
      buildFeatures() {
        const r = el('ridges'), n = el('nostrils'), ls = el('lowerScutes');
        r.appendChild(capsule(214, 414, 64, 16, 16, 'var(--skin-1)'));
        r.appendChild(capsule(386, 414, 64, 16, -16, 'var(--skin-1)'));
        for (let k = 0; k < 4; k++) { const y = 488 + k * 26; scuteBump(r, 285, y, 12, 9); scuteBump(r, 315, y, 12, 9); }
        for (let i = 0; i < 7; i++) { const t = i / 6, x = 170 + t * 260, y = 398 - Math.sin(Math.PI * t) * 14; scuteBump(r, x, y, 10, 8); }
        for (let i = 0; i < 3; i++) { scuteBump(r, 120 + i * 10, 545 + i * 16, 9, 7); scuteBump(r, 480 - i * 10, 545 + i * 16, 9, 7); }
        r.appendChild(svgEl('path', { d: 'M250,560 Q300,548 350,560', fill: 'none', stroke: 'var(--skin-edge)', 'stroke-width': 3, opacity: 0.3 }));
        n.appendChild(svgEl('ellipse', { cx: 272, cy: 456, rx: 18, ry: 13, fill: 'var(--skin-1)', stroke: 'var(--skin-edge)', 'stroke-width': 3 }));
        n.appendChild(svgEl('ellipse', { cx: 328, cy: 456, rx: 18, ry: 13, fill: 'var(--skin-1)', stroke: 'var(--skin-edge)', 'stroke-width': 3 }));
        n.appendChild(svgEl('path', { d: 'M266,455 Q272,462 278,455', fill: 'none', stroke: '#0c0c08', 'stroke-width': 4, 'stroke-linecap': 'round' }));
        n.appendChild(svgEl('path', { d: 'M322,455 Q328,462 334,455', fill: 'none', stroke: '#0c0c08', 'stroke-width': 4, 'stroke-linecap': 'round' }));
        for (let i = 0; i < 8; i++) { const x = 140 + i * 46; scuteBump(ls, x, 726 + (i % 2) * 10, 11, 8); }
      },
    },
    shark: {
      upper: 'M72,612 Q66,498 158,436 Q234,372 300,360 Q366,372 442,436 Q534,498 528,612 Q300,556 72,612 Z',
      lower: 'M82,600 Q300,556 518,600 Q556,674 532,792 Q300,858 68,792 Q44,674 82,600 Z',
      mouthFill: 'url(#mouthGradPink)', tongue: '#c76a7c', dorsal: 'M262,372 L338,372 L300,264 Z', texU: 0.08, texL: 0.06,
      tooth: { style: 'triangle', wMul: 0.5, hMul: 0.95 },
      buildEyes(g) { eyeBlack(g, 166, 452, -6); eyeBlack(g, 434, 452, 6); },
      buildFeatures() {
        const r = el('ridges'), n = el('nostrils');
        r.appendChild(svgEl('ellipse', { cx: 300, cy: 472, rx: 96, ry: 64, fill: 'var(--skin-belly)', opacity: 0.16 }));
        for (let i = 0; i < 4; i++) {
          const y = 546 + i * 22;
          r.appendChild(svgEl('path', { d: `M112,${y} Q128,${y + 15} 142,${y + 2}`, fill: 'none', stroke: '#16232e', 'stroke-width': 6, 'stroke-linecap': 'round', opacity: 0.7 }));
          r.appendChild(svgEl('path', { d: `M488,${y} Q472,${y + 15} 458,${y + 2}`, fill: 'none', stroke: '#16232e', 'stroke-width': 6, 'stroke-linecap': 'round', opacity: 0.7 }));
        }
        n.appendChild(svgEl('path', { d: 'M282,492 q-8,7 0,13', fill: 'none', stroke: '#10202a', 'stroke-width': 4, 'stroke-linecap': 'round' }));
        n.appendChild(svgEl('path', { d: 'M318,492 q8,7 0,13', fill: 'none', stroke: '#10202a', 'stroke-width': 4, 'stroke-linecap': 'round' }));
      },
    },
    dino: { // 티라노사우루스
      upper: 'M60,616 Q54,494 108,452 Q150,424 214,414 Q300,404 386,414 Q450,424 492,452 Q546,494 540,616 Q300,556 60,616 Z',
      lower: 'M68,600 Q300,554 532,600 Q576,682 550,808 Q300,886 50,808 Q24,682 68,600 Z',
      mouthFill: 'url(#mouthGrad)', tongue: '#6e1220', dorsal: null, texU: 0.2, texL: 0.18,
      tooth: { style: 'banana', wMul: 0.82, hMul: 1.22 },
      buildEyes(g) { eyePredator(g, 214, 452, -8, '#f0b23a'); eyePredator(g, 386, 452, 8, '#f0b23a'); },
      buildFeatures() {
        const r = el('ridges'), n = el('nostrils'), ls = el('lowerScutes');
        // 뼈로 된 눈두덩 뿔(사나운 각도)
        r.appendChild(svgEl('path', { d: 'M170,438 Q188,404 246,420 Q250,432 240,442 Q206,430 170,438 Z', fill: 'var(--skin-1)', stroke: 'var(--skin-edge)', 'stroke-width': 3 }));
        r.appendChild(svgEl('path', { d: 'M430,438 Q412,404 354,420 Q350,432 360,442 Q394,430 430,438 Z', fill: 'var(--skin-1)', stroke: 'var(--skin-edge)', 'stroke-width': 3 }));
        // 콧등 능선 융기
        r.appendChild(svgEl('path', { d: 'M268,432 Q300,402 332,432 Q300,448 268,432 Z', fill: 'var(--skin-1)', stroke: 'var(--skin-edge)', 'stroke-width': 3 }));
        for (let i = 0; i < 6; i++) { const t = i / 5, x = 200 + t * 200, y = 476 + Math.sin(Math.PI * t) * 8; scuteBump(r, x, y, 11, 8); }
        for (let i = 0; i < 4; i++) { scuteBump(r, 150 + i * 8, 520 + i * 14, 9, 7); scuteBump(r, 450 - i * 8, 520 + i * 14, 9, 7); }
        n.appendChild(svgEl('ellipse', { cx: 280, cy: 448, rx: 13, ry: 10, fill: '#0c0c08', opacity: 0.78 }));
        n.appendChild(svgEl('ellipse', { cx: 320, cy: 448, rx: 13, ry: 10, fill: '#0c0c08', opacity: 0.78 }));
        for (let i = 0; i < 8; i++) { const x = 140 + i * 46; scuteBump(ls, x, 724 + (i % 2) * 10, 11, 8); }
      },
    },
    monster: {
      upper: 'M62,612 Q42,470 132,428 Q210,400 300,398 Q390,400 468,428 Q558,470 538,612 Q300,556 62,612 Z',
      lower: 'M66,600 Q300,548 534,600 Q580,678 550,802 Q300,880 50,802 Q20,678 66,600 Z',
      mouthFill: 'url(#mouthGrad)', tongue: '#4a1030', dorsal: null, texU: 0.18, texL: 0.16,
      tooth: { style: 'conic', wMul: 0.62, hMul: 1.06 },
      buildEyes(g) { eyePredator(g, 210, 442, -10, '#ff4a3a'); eyePredator(g, 390, 442, 10, '#ff4a3a'); },
      buildFeatures() {
        const r = el('ridges'), ls = el('lowerScutes'), n = el('nostrils');
        r.appendChild(hornSpike(196, 402, -20));
        r.appendChild(hornSpike(404, 402, 20));
        r.appendChild(capsule(210, 418, 58, 15, 20, 'var(--skin-1)'));
        r.appendChild(capsule(390, 418, 58, 15, -20, 'var(--skin-1)'));
        for (let k = 0; k < 4; k++) { const y = 490 + k * 26; scuteBump(r, 285, y, 12, 9); scuteBump(r, 315, y, 12, 9); }
        for (let i = 0; i < 3; i++) { scuteBump(r, 120 + i * 10, 545 + i * 16, 9, 7); scuteBump(r, 480 - i * 10, 545 + i * 16, 9, 7); }
        n.appendChild(svgEl('ellipse', { cx: 272, cy: 456, rx: 15, ry: 11, fill: '#0c0c08', opacity: 0.7 }));
        n.appendChild(svgEl('ellipse', { cx: 328, cy: 456, rx: 15, ry: 11, fill: '#0c0c08', opacity: 0.7 }));
        for (let i = 0; i < 8; i++) { const x = 140 + i * 46; scuteBump(ls, x, 726 + (i % 2) * 10, 11, 8); }
      },
    },
  };

  function applyCreature(char) {
    const c = CREATURES[char] || CREATURES.crocodile;
    state.creature = c;
    el('upperBody').setAttribute('d', c.upper);
    el('lowerBody').setAttribute('d', c.lower);
    el('mouthInner').setAttribute('fill', c.mouthFill);
    el('tongue').setAttribute('fill', c.tongue);
    const fin = el('dorsalFin');
    if (c.dorsal) { fin.setAttribute('d', c.dorsal); fin.style.opacity = '1'; } else { fin.style.opacity = '0'; }
    const tu = el('skinTexU'), tl = el('skinTexL');
    if (tu) tu.setAttribute('opacity', c.texU);
    if (tl) tl.setAttribute('opacity', c.texL);
    el('eyes').innerHTML = ''; el('nostrils').innerHTML = ''; el('ridges').innerHTML = ''; el('lowerScutes').innerHTML = '';
    c.buildEyes(el('eyes'));
    c.buildFeatures();
  }

  // 이빨 형태(캐릭터별): conic(악어) / triangle(상어, 톱니) / banana(티라노, 큰 송곳니)
  function toothPath(w, h, down, style) {
    const s = down ? -1 : 1;
    if (style === 'triangle') {
      return `M ${-w / 2},0 L ${-w * 0.3},${-h * 0.42 * s} L ${-w * 0.17},${-h * 0.36 * s} `
        + `L ${-w * 0.09},${-h * 0.74 * s} L 0,${-h * s} L ${w * 0.09},${-h * 0.74 * s} `
        + `L ${w * 0.17},${-h * 0.36 * s} L ${w * 0.3},${-h * 0.42 * s} L ${w / 2},0 Z`;
    }
    if (style === 'banana') {
      return `M ${-w / 2},0 Q ${-w * 0.52},${-h * 0.55 * s} ${-w * 0.22},${-h * 0.9 * s} `
        + `Q ${-w * 0.05},${-h * 1.08 * s} ${w * 0.14},${-h * 0.92 * s} `
        + `Q ${w * 0.46},${-h * 0.6 * s} ${w / 2},0 Z`;
    }
    return `M ${-w / 2},0 Q ${-w * 0.36},${-h * 0.5 * s} ${-w * 0.1},${-h * 0.86 * s} `
      + `Q 0,${-h * 1.03 * s} ${w * 0.1},${-h * 0.86 * s} `
      + `Q ${w * 0.36},${-h * 0.5 * s} ${w / 2},0 Z`;
  }
  function toothScale(i) { return 0.82 + 0.18 * (((i * 37 + 11) % 7) / 6); }

  function buildTeeth(n) {
    const c = state.creature || CREATURES.crocodile;
    const ts = c.tooth || { style: 'conic', wMul: 0.58, hMul: 1 };
    const lower = el('teethLower'), upper = el('teethUpper');
    lower.innerHTML = ''; upper.innerHTML = '';
    const spacing = (TEETH_RIGHT - TEETH_LEFT) / Math.max(1, n - 1);
    const w = Math.min(46, Math.max(13, spacing * ts.wMul));
    for (let i = 0; i < n; i++) {
      const x = toothX(i, n);
      const hL = TOOTH_H * ts.hMul * toothScale(i);
      // 아래 이빨 (누르는 버튼, 위로 솟음) — 잇몸 소켓 + 송곳니
      const ly = toothArcY(i, n, GUM_Y, 22);
      const lg = svgEl('g', { class: 'tooth', 'data-i': i, transform: `translate(${x.toFixed(1)},${ly.toFixed(1)})` });
      lg.appendChild(svgEl('ellipse', { cx: 0, cy: 0, rx: w * 0.62, ry: 7, fill: 'var(--skin-shadow)', opacity: 0.5 }));
      const inner = svgEl('g', { class: 'tooth-inner' });
      inner.appendChild(svgEl('ellipse', { class: 'tooth-glow', cx: 0, cy: -hL * 0.55, rx: w * 0.66, ry: hL * 0.6, fill: 'rgba(255,214,130,0.22)' }));
      inner.appendChild(svgEl('path', { d: toothPath(w, hL, false, ts.style), fill: 'url(#toothGrad)', stroke: 'var(--teeth-edge)', 'stroke-width': 1.5 }));
      lg.appendChild(inner);
      lg.addEventListener('click', () => onToothClick(i));
      lower.appendChild(lg);
      // 위 이빨 (아래로 향함, 위턱과 함께 이동)
      const uy = toothArcY(i, n, UPPER_Y, 16);
      const ug = svgEl('g', { transform: `translate(${x.toFixed(1)},${uy.toFixed(1)})` });
      ug.appendChild(svgEl('ellipse', { cx: 0, cy: 0, rx: w * 0.58, ry: 6, fill: 'var(--skin-shadow)', opacity: 0.45 }));
      ug.appendChild(svgEl('path', { d: toothPath(w * 0.92, TOOTH_H * ts.hMul * 0.9 * toothScale(i + 3), true, ts.style), fill: 'url(#toothGradD)', stroke: 'var(--teeth-edge)', 'stroke-width': 1.5 }));
      upper.appendChild(ug);
    }
  }
  function toothInnerAt(i) {
    const g = el('teethLower').querySelector(`.tooth[data-i="${i}"]`);
    return g ? g.querySelector('.tooth-inner') : null;
  }
  function toothTipXY(i, n) {
    // 위 이빨 끝(침이 떨어지는 지점) 근사 — viewBox 좌표 (현재 위턱 이동량 반영)
    const x = toothX(i, n);
    const y = toothArcY(i, n, UPPER_Y, 14) + TOOTH_H * 0.82 + Jaw.offset;
    return { x, y };
  }

  // ═══════════════════════════════════════════════════════════
  //  화면 전환
  // ═══════════════════════════════════════════════════════════
  function show(screen) {
    state.screen = screen;
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    el('screen-' + screen).classList.add('active');
  }
  function toast(msg) {
    const t = el('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function flash(text, ms) {
    const f = el('stage-flash');
    f.textContent = text;
    f.classList.remove('show'); void f.offsetWidth; f.classList.add('show');
    if (ms) { f.style.animationDuration = ms + 'ms'; }
  }
  function shake(node) {
    node = node || el('stage');
    node.classList.remove('shake'); void node.offsetWidth; node.classList.add('shake');
  }

  // ═══════════════════════════════════════════════════════════
  //  홈 화면
  // ═══════════════════════════════════════════════════════════
  const RAND_NAMES = ['용감한하마', '겁많은토끼', '느긋한나무늘보', '수상한너구리', '배고픈여우',
    '졸린판다', '까칠한고슴도치', '천하무적', '럭키비키', '오늘의행운', '무서운게없어', '떨고있니'];
  function randomName() { return RAND_NAMES[Math.floor(Math.random() * RAND_NAMES.length)]; }
  function myName() {
    const v = el('in-name').value.trim();
    return v || localStorage.getItem('croc-name') || '';
  }
  function rememberName() {
    const v = el('in-name').value.trim();
    if (v) localStorage.setItem('croc-name', v);
  }

  el('btn-rand-name').addEventListener('click', () => { el('in-name').value = randomName(); });
  el('btn-create').addEventListener('click', () => {
    audioReady();
    const name = myName() || randomName();
    el('in-name').value = name; rememberName();
    socket.emit('croc:create', { name, character: 'crocodile', teeth: 12, mode: 'single', token }, (res) => {
      if (!res || !res.ok) return toast((res && res.error) || '방 생성 실패');
      state.role = 'player';
      enterRoom(res.code);
    });
  });
  el('btn-join').addEventListener('click', () => doJoin());
  el('in-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  function doJoin() {
    audioReady();
    const code = el('in-code').value.trim().toUpperCase();
    if (code.length < 4) return toast('초대코드를 입력해주세요');
    const name = myName() || randomName();
    el('in-name').value = name; rememberName();
    socket.emit('croc:join', { code, name, token }, (res) => {
      if (!res || !res.ok) return toast((res && res.error) || '입장 실패');
      state.role = 'player';
      enterRoom(res.code);
    });
  }
  el('btn-spectate').addEventListener('click', () => {
    const code = el('in-code').value.trim().toUpperCase();
    if (code.length < 4) return toast('관전할 방의 초대코드를 입력해주세요');
    socket.emit('croc:spectate', { code }, (res) => {
      if (!res || !res.ok) return toast((res && res.error) || '관전 실패');
      state.role = 'spectator';
      enterRoom(res.code);
    });
  });

  function enterRoom(code) {
    state.code = code;
    try { history.replaceState(null, '', '/crocodile?room=' + code); } catch {}
    show('lobby');
    // croc:room 브로드캐스트가 이 콜백보다 먼저 도착했을 수 있으니, 있으면 즉시 렌더한다.
    if (state.room && state.room.code === code) {
      if (state.room.state === 'playing') { enterGame(state.room); syncMidGame(state.room); }
      else renderLobby(state.room);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  로비
  // ═══════════════════════════════════════════════════════════
  function renderLobby(room) {
    el('lobby-code').textContent = room.code;
    // QR
    try {
      const url = location.origin + '/crocodile?room=' + room.code;
      const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
      el('qr-box').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
    } catch {}
    // 참가자
    el('player-count').textContent = room.players.length;
    el('spec-count').textContent = room.spectators ? '👀 ' + room.spectators : '';
    const ul = el('player-list'); ul.innerHTML = '';
    room.players.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'player-item' + (p.disconnected ? ' off' : '');
      const isHost = p.id === room.hostId;
      const isMe = p.id === state.myId;
      li.innerHTML =
        `<span class="pl-dot" style="background:${p.color}"></span>` +
        `<span class="pl-name">${escapeHtml(p.name)}</span>` +
        (isHost ? '<span class="pl-tag">방장</span>' : '') +
        (isMe ? '<span class="pl-tag me">나</span>' : '');
      ul.appendChild(li);
    });
    // 호스트 패널 vs 대기 안내
    const amHost = room.hostId === state.myId && state.role === 'player';
    el('host-panel').classList.toggle('show', amHost);
    el('guest-wait').classList.toggle('show', !amHost && state.role === 'player');
    // 옵션 UI 반영
    document.querySelectorAll('.char-btn').forEach((b) =>
      b.classList.toggle('sel', b.dataset.char === room.character));
    el('teeth-val').textContent = room.teeth;
    document.querySelectorAll('#mode-seg .seg-btn').forEach((b) =>
      b.classList.toggle('sel', b.dataset.mode === room.mode));
    state.teeth = room.teeth; state.character = room.character;
    // 무대 스킨 미리 반영
    el('stage').setAttribute('data-char', room.character);
  }

  // 호스트 옵션 조작
  document.querySelectorAll('.char-btn').forEach((b) =>
    b.addEventListener('click', () => socket.emit('croc:setCharacter', { character: b.dataset.char })));
  el('teeth-minus').addEventListener('click', () => socket.emit('croc:setTeeth', { teeth: state.teeth - 1 }));
  el('teeth-plus').addEventListener('click', () => socket.emit('croc:setTeeth', { teeth: state.teeth + 1 }));
  document.querySelectorAll('#mode-seg .seg-btn').forEach((b) =>
    b.addEventListener('click', () => socket.emit('croc:setMode', { mode: b.dataset.mode })));
  el('btn-start').addEventListener('click', () => { audioReady(); socket.emit('croc:start'); });

  el('btn-leave-lobby').addEventListener('click', leaveRoom);
  el('btn-leave-game').addEventListener('click', leaveRoom);
  function leaveRoom() {
    socket.emit('croc:leave');
    state.code = null; state.room = null; state.role = null;
    try { history.replaceState(null, '', '/crocodile'); } catch {}
    show('home');
  }

  // 공유/복사
  function shareUrl() { return location.origin + '/crocodile?room=' + state.code; }
  el('btn-share').addEventListener('click', async () => {
    const url = shareUrl();
    if (navigator.share) { try { await navigator.share({ title: '악어 룰렛', text: '같이 하자! 🐊', url }); return; } catch {} }
    copy(url);
  });
  el('btn-copy-link').addEventListener('click', () => copy(shareUrl()));
  function copy(text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('초대링크 복사됨!'), () => toast(text));
    else toast(text);
  }

  // ═══════════════════════════════════════════════════════════
  //  게임 진입 / 인트로
  // ═══════════════════════════════════════════════════════════
  function enterGame(room) {
    show('game');
    el('stage').setAttribute('data-char', room.character);
    applyCreature(room.character); // 캐릭터별 형태·눈·특징 적용
    buildTeeth(room.teeth);
    if (!Jaw.node) Jaw.init(el('upperJaw'));
    crocNode = el('croc'); birdNode = el('bird');
    document.querySelectorAll('.tooth.pressed').forEach((t) => t.classList.remove('pressed'));
  }

  // 인트로: 물 밑에서 스믈스믈 떠올라 → 입을 '악!' 벌림
  // 캐릭터 이름/포효
  const CREATURE_NAME = { crocodile: '악어', shark: '상어', dino: '티라노사우루스', monster: '몬스터' };
  const CREATURE_ROAR = { crocodile: '으르렁!', shark: '촤아악!', dino: '크아앙!', monster: '크르릉!' };

  // 🎬 시네마틱 인트로: 저 멀리서 카메라로 다가와 수면을 뚫고 포효 → 게임으로 페이드
  async function playIntro() {
    lockInput(true);
    const croc = el('croc');
    const scene = el('scene');
    const cinema = el('cinema');
    Jaw.breathe = false;
    Jaw.setInstant(JAW.closed);

    // 컷씬 시작: 레터박스 내려오고 화면 어둡게
    cinema.classList.add('on');
    requestAnimationFrame(() => cinema.classList.add('bars', 'dark'));

    // 딥: 크리쳐가 물속 저 멀리(작고 어둡게), 카메라 살짝 당겨짐
    croc.style.transition = 'none';
    croc.style.transformOrigin = '50% 70%';
    croc.style.transform = 'translateY(340px) scale(0.5)';
    croc.style.opacity = '0.1';
    scene.style.transformOrigin = '50% 60%';
    scene.style.transition = 'none';
    scene.style.transform = 'scale(1.18)';
    el('waterFill').style.opacity = '0.99';
    await sleep(120);

    cineTitle(CREATURE_NAME[state.character] || '???');
    sfxDrone(3200); // 다가오는 저음 드론 (고조)

    // 접근: 점점 커지며 좌우로 스웨이하며 다가옴 + 카메라 서서히 줌인
    const approach = croc.animate(
      [
        { transform: 'translateY(340px) scale(0.5)', opacity: 0.1 },
        { transform: 'translateY(250px) translateX(16px) scale(0.66)', opacity: 0.3, offset: 0.34 },
        { transform: 'translateY(130px) translateX(-14px) scale(0.88)', opacity: 0.75, offset: 0.72 },
        { transform: 'translateY(0) translateX(0) scale(1)', opacity: 1 },
      ],
      { duration: 3200, easing: 'cubic-bezier(.45,0,.22,1)', fill: 'forwards' }
    );
    scene.animate([{ transform: 'scale(1.18)' }, { transform: 'scale(1.02)' }],
      { duration: 3200, easing: 'ease-out', fill: 'forwards' });
    bubbles(2800);
    setTimeout(() => blink(), 1500);
    setTimeout(() => { splash(300, 700, 28); sfx.splash(); }, 2650); // 수면 돌파
    el('waterFill').animate([{ opacity: 0.99 }, { opacity: 0.82 }], { duration: 1700, delay: 1300, fill: 'forwards' });
    await approach.finished.catch(() => {});
    croc.style.transform = 'translateY(0) scale(1)'; croc.style.opacity = '1';

    // 클로즈업 포효: 카메라가 확 들어갔다 나오며 입을 쫙
    scene.animate([{ transform: 'scale(1.02)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }],
      { duration: 720, easing: 'ease-out', fill: 'forwards' });
    await sleep(120);
    flash(CREATURE_ROAR[state.character] || '크아앙!', 900);
    sfx.roar();
    shake(el('stage'));
    splash(300, 560, 22, 'rgba(180,230,255,0.85)');
    await Jaw.to(JAW.wide, 320, easeOutBack);

    // 페이드아웃 → 실제 게임: 레터박스 걷히고 카메라 원위치, UI 활성
    cinema.classList.remove('bars', 'dark');
    await Jaw.to(JAW.idle, 520, easeOutCubic);
    setTimeout(() => { cinema.classList.remove('on'); scene.style.transform = ''; scene.style.transition = ''; }, 560);
    Jaw.breathe = true;
    lockInput(false);
  }

  function cineTitle(text) {
    const t = el('cine-title');
    t.textContent = text;
    t.animate(
      [
        { opacity: 0, transform: 'translateY(14px) scale(0.96)', filter: 'blur(6px)' },
        { opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0)', offset: 0.25 },
        { opacity: 1, offset: 0.68 },
        { opacity: 0, transform: 'translateY(-8px)', filter: 'blur(3px)' },
      ],
      { duration: 2600, easing: 'ease' }
    );
  }

  // 상승 거품 (접근 연출)
  function bubbles(ms) {
    const layer = ensureParticleLayer();
    const t0 = performance.now();
    const spawn = () => {
      if (performance.now() - t0 > ms) return;
      const b = document.createElementNS(SVGNS, 'circle');
      const x = 120 + Math.random() * 360, r = 3 + Math.random() * 8;
      b.setAttribute('cx', x); b.setAttribute('cy', 780); b.setAttribute('r', r);
      b.setAttribute('fill', 'none'); b.setAttribute('stroke', 'rgba(180,230,240,0.5)'); b.setAttribute('stroke-width', 2);
      layer.appendChild(b);
      const rise = 300 + Math.random() * 260, drift = (Math.random() - 0.5) * 60;
      const a = b.animate(
        [{ transform: 'translate(0,0)', opacity: 0.7 }, { transform: `translate(${drift}px,${-rise}px)`, opacity: 0 }],
        { duration: 1400 + Math.random() * 900, easing: 'ease-out' }
      );
      a.onfinish = () => b.remove();
      setTimeout(spawn, 90 + Math.random() * 120);
    };
    spawn();
  }

  // 다가오는 저음 드론 (WebAudio, 서서히 고조)
  function sfxDrone(ms) {
    if (!state.sound) return;
    const ac = audioReady(); if (!ac) return;
    const t = ac.currentTime, dur = ms / 1000;
    const o = ac.createOscillator(), g = ac.createGain(), lp = ac.createBiquadFilter();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(42, t);
    o.frequency.exponentialRampToValueAtTime(130, t + dur);
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(300, t); lp.frequency.exponentialRampToValueAtTime(900, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + dur * 0.82);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.3);
    o.connect(lp).connect(g).connect(ac.destination);
    o.start(t); o.stop(t + dur + 0.4);
    // 긴장 심박 (접근 중 낮은 펄스)
    for (let i = 0; i < 5; i++) setTimeout(() => tone(60, 0.12, 'sine', 0.12), (i + 1) * (ms / 6));
  }

  function blink() {
    document.querySelectorAll('.eye').forEach((e) => {
      e.classList.add('blink');
      setTimeout(() => e.classList.remove('blink'), 130);
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  이빨 누르기 (내 턴)
  // ═══════════════════════════════════════════════════════════
  function onToothClick(i) {
    if (state.busy || !state.myTurn || state.role !== 'player') return;
    if (state.room && state.room.pressed && state.room.pressed[i]) return;
    const inner = toothInnerAt(i);
    if (inner && inner.parentElement.classList.contains('pressed')) return;
    // 즉시 잠금 + 살짝 눌린 피드백 (서버 이벤트가 본 연출을 재생)
    lockInput(true);
    if (inner) inner.style.transform = 'translateY(6px)';
    sfx.tick();
    socket.emit('croc:press', { tooth: i });
  }

  function pressToothVisual(i, safe) {
    const g = el('teethLower').querySelector(`.tooth[data-i="${i}"]`);
    if (!g) return;
    g.classList.add('pressed');
    g.classList.remove('pressable');
    const inner = g.querySelector('.tooth-inner');
    if (inner) {
      inner.animate(
        [{ transform: inner.style.transform || 'translateY(0)' }, { transform: 'translateY(44px)' }],
        { duration: 220, easing: 'cubic-bezier(.3,1.4,.5,1)', fill: 'forwards' }
      );
    }
    const p = g.querySelector('path');
    if (p) p.setAttribute('fill', safe ? '#b7ad8c' : '#c98a8a');
  }

  // 입력 잠금 = 이빨 클릭 가능 여부 갱신
  function lockInput(lock) {
    state.busy = lock;
    refreshPressable();
  }
  function refreshPressable() {
    const canPress = state.myTurn && !state.busy && state.role === 'player' &&
      state.room && state.room.state === 'playing';
    document.querySelectorAll('#teethLower .tooth').forEach((g) => {
      const i = Number(g.dataset.i);
      const pressedNow = state.room && state.room.pressed && state.room.pressed[i];
      if (g.classList.contains('pressed') || pressedNow) { g.classList.remove('pressable'); return; }
      g.classList.toggle('pressable', !!canPress);
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  드라마 연출 (서버가 지시 → 전원 동일 재생)
  // ═══════════════════════════════════════════════════════════
  async function playDrama(kind, toothIndex) {
    const n = state.teeth;
    switch (kind) {
      case 'drool': {
        for (let k = 0; k < 3; k++) {
          const ti = clamp(toothIndex + (k - 1), 0, n - 1);
          const tp = toothTipXY(ti, n);
          setTimeout(() => { drool(tp.x, tp.y); sfx.drip(); }, k * 130);
        }
        await Jaw.to(JAW.idle + 3, 180, easeOutCubic);
        await Jaw.to(JAW.idle, 260, easeOutCubic);
        break;
      }
      case 'twitch': {
        blink();
        sfx.tension();
        await Jaw.to(JAW.idle + 8, 110);
        await Jaw.to(JAW.idle + 2, 90);
        await Jaw.to(JAW.idle + 7, 100);
        await Jaw.to(JAW.idle, 220, easeOutBack);
        break;
      }
      case 'bird': {
        flash('🐦 악어새!', 1100);
        await birdSaves();
        break;
      }
      case 'chomp-fake': {
        // 확 다물다가 코앞에서 딱 멈춤 → 다시 벌림 (최고 페이크)
        flash('앗...?!', 700);
        const tp = toothTipXY(toothIndex, n);
        drool(tp.x, tp.y);
        sfx.tension();
        await Jaw.to(JAW.fake, 150, easeOutCubic); // 거의 다 닫힘!
        sfx.fake();
        shake(el('stage'));
        await sleep(280);                          // 손끝 코앞에서 정지 (긴장)
        await Jaw.to(JAW.idle - 3, 380, easeOutBack); // 화들짝 다시 벌림
        flash('세이프…', 600);
        await Jaw.to(JAW.idle, 300, easeOutCubic);
        break;
      }
      default: { // 'none' — 잔잔한 끄덕임
        await Jaw.to(JAW.idle + 4, 150);
        await Jaw.to(JAW.idle, 200, easeOutBack);
      }
    }
  }

  // 악어새가 날아와 입을 못 다물게 함
  async function birdSaves() {
    const bird = el('bird');
    const wing = el('wing');
    bird.style.opacity = '1';
    // 날개 퍼덕임
    const flap = wing.animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-40deg)' }, { transform: 'rotate(0deg)' }],
      { duration: 180, iterations: 12, easing: 'ease-in-out' }
    );
    wing.style.transformBox = 'view-box';
    // 오른쪽에서 입 앞(중앙)으로 날아옴
    const fly = bird.animate(
      [
        { transform: 'translate(560px, 180px) scale(0.6)' },
        { transform: 'translate(330px, 470px) scale(1)', offset: 0.6 },
        { transform: 'translate(300px, 452px) scale(1)' },
      ],
      { duration: 720, easing: 'cubic-bezier(.3,.7,.5,1)', fill: 'forwards' }
    );
    sfx.bird();
    await fly.finished.catch(() => {});
    // 악어가 다물려 하지만 새가 막아섬
    await Jaw.to(JAW.idle + 10, 200, easeOutCubic);
    sfx.tension();
    shake(el('stage'));
    await sleep(120);
    // 새가 톡톡 → 다시 활짝
    await Jaw.to(JAW.wide, 320, easeOutBack);
    flash('휴~', 600);
    // 새가 날아감
    const away = bird.animate(
      [{ transform: 'translate(300px, 452px) scale(1)', opacity: 1 },
       { transform: 'translate(-40px, 180px) scale(0.5)', opacity: 0 }],
      { duration: 720, easing: 'ease-in', fill: 'forwards' }
    );
    await away.finished.catch(() => {});
    flap.cancel(); bird.style.opacity = '0';
    await Jaw.to(JAW.idle, 300, easeOutCubic);
  }

  // 진짜 물기 — 느린 긴장 → 망설임 → 쾅!
  async function playBite(ev) {
    lockInput(true);
    Jaw.breathe = false;
    pressToothVisual(ev.tooth, false);
    // 침 뚝뚝 + 슬금슬금 다물기 (긴장 최고조)
    const tp = toothTipXY(ev.tooth, state.teeth);
    drool(tp.x, tp.y); drool(tp.x - 20, tp.y);
    sfx.tension();
    flash('물까…?', 1200);
    await Jaw.to(-6, 750, easeInOutCubic); // 슬금슬금 내려옴
    await sleep(120);
    drool(tp.x + 15, tp.y);
    // 망설임 — 부르르 떨림
    await Jaw.to(-3, 160);
    await Jaw.to(-8, 160);
    await Jaw.to(-4, 140);
    await sleep(260);
    // 쾅!!!
    await Jaw.to(JAW.bite, 90, easeOutCubic);
    sfx.chomp();
    shake(el('stage'));
    redFlash();
    flash('쾅!!', 900);
    splash(300, 560, 24, 'rgba(255,120,120,0.9)');
    // 물린 채로 부르르
    await Jaw.to(JAW.bite - 2, 70);
    await Jaw.to(JAW.bite, 70);
    await sleep(500);
  }

  function redFlash() {
    const s = el('stage');
    const ov = document.createElement('div');
    ov.style.cssText = 'position:absolute;inset:0;background:radial-gradient(circle,rgba(255,40,60,.55),rgba(255,0,0,.15));pointer-events:none;';
    s.appendChild(ov);
    ov.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 600, easing: 'ease-out' }).onfinish = () => ov.remove();
  }

  // 서바이벌: 물린 뒤 이빨 리셋 → 다시 입 벌림
  async function playReload(ev) {
    buildTeeth(ev.teeth || state.teeth);
    Jaw.setInstant(JAW.closed);
    await sleep(150);
    flash('악!', 600);
    sfx.roar();
    await Jaw.to(JAW.wide, 300, easeOutBack);
    await Jaw.to(JAW.idle, 400, easeOutCubic);
    Jaw.breathe = true;
    lockInput(false);
  }

  // ═══════════════════════════════════════════════════════════
  //  턴 표시
  // ═══════════════════════════════════════════════════════════
  function updateTurn(turnId) {
    const room = state.room;
    if (!room) return;
    state.myTurn = turnId === state.myId && state.role === 'player';
    const banner = el('turn-banner');
    const p = room.players.find((x) => x.id === turnId);
    const avatar = el('turn-avatar');
    if (p) {
      avatar.style.background = p.color;
      if (state.myTurn) {
        el('turn-text').innerHTML = '👉 <b>당신 차례!</b> 이빨을 눌러요';
        banner.classList.add('mine');
      } else {
        el('turn-text').innerHTML = `<b>${escapeHtml(p.name)}</b> 님 차례`;
        banner.classList.remove('mine');
      }
    } else {
      avatar.style.background = 'transparent';
      el('turn-text').textContent = '…';
      banner.classList.remove('mine');
    }
    refreshPressable();
  }
  function updateProgress() {
    const room = state.room;
    if (!room || !room.pressed) { el('progress-info').textContent = ''; return; }
    const pressed = room.pressed.filter(Boolean).length;
    const remain = room.teeth - pressed;
    const modeTxt = room.mode === 'survival' ? '서바이벌' : '한 명 당첨';
    el('progress-info').textContent = `${modeTxt} · 이빨 ${room.teeth}개 중 ${pressed}개 눌림 · 남은 ${remain}개`;
  }

  // ═══════════════════════════════════════════════════════════
  //  소켓 이벤트
  // ═══════════════════════════════════════════════════════════
  socket.on('connect', () => {
    state.myId = socket.id;
    // 재접속 복원 시도
    if (state.code) {
      socket.emit('croc:resume', { code: state.code, token }, (res) => {
        if (res && res.ok) { /* room 업데이트가 뒤따름 */ }
      });
    }
  });

  socket.on('croc:room', (room) => {
    state.room = room;
    state.teeth = room.teeth;
    state.character = room.character;
    if (state.screen === 'lobby' || (state.screen === 'home' && state.code)) {
      if (room.state === 'lobby') { show('lobby'); renderLobby(room); }
    }
    if (state.screen === 'lobby') renderLobby(room);
    // 진행 중 방에 (관전/재접속으로) 들어온 경우 게임 화면 동기화.
    // 단, 방장이 방금 시작한 경우엔 croc:begin(인트로)이 곧 뒤따르므로 잠깐 기다렸다가
    // 안 오면(=중간 합류) 그때 조용히 동기화한다. (인트로 없이 입 벌린 상태가 번쩍이는 것 방지)
    if (room.state === 'playing' && state.screen !== 'game') {
      if (state._midJoinTimer) clearTimeout(state._midJoinTimer);
      state._midJoinTimer = setTimeout(() => {
        state._midJoinTimer = null;
        if (state.screen !== 'game') { enterGame(room); syncMidGame(room); }
      }, 350);
    }
    if (room.state === 'playing' && state.screen === 'game') {
      // 눌린 상태 동기화 (표시만)
      if (room.pressed) room.pressed.forEach((v, i) => { if (v) markPressed(i); });
      if (!state.busy) updateTurn(room.turnId);
      updateProgress();
    }
    if (room.state === 'lobby' && state.screen === 'game') {
      // 다시하기로 로비 복귀
      hideResult();
      show('lobby'); renderLobby(room);
    }
  });

  function markPressed(i) {
    const g = el('teethLower').querySelector(`.tooth[data-i="${i}"]`);
    if (g && !g.classList.contains('pressed')) {
      g.classList.add('pressed'); g.classList.remove('pressable');
      const inner = g.querySelector('.tooth-inner');
      if (inner) inner.style.transform = 'translateY(44px)';
      const p = g.querySelector('path'); if (p) p.setAttribute('fill', '#b7ad8c');
    }
  }
  function syncMidGame(room) {
    Jaw.breathe = false; Jaw.setInstant(JAW.idle); Jaw.breathe = true;
    el('croc').style.transform = 'translateY(0)'; el('croc').style.opacity = '1';
    if (room.pressed) room.pressed.forEach((v, i) => { if (v) markPressed(i); });
    updateTurn(room.turnId);
    updateProgress();
    lockInput(false);
  }

  // 게임 시작 (인트로 재생)
  socket.on('croc:begin', async (ev) => {
    if (state._midJoinTimer) { clearTimeout(state._midJoinTimer); state._midJoinTimer = null; }
    state.teeth = ev.teeth;
    if (state.screen !== 'game') enterGame(state.room || { character: state.character, teeth: ev.teeth });
    else buildTeeth(ev.teeth);
    hideResult();
    updateTurn(null);
    await playIntro();
    updateTurn(ev.turnId);
    updateProgress();
  });

  // 안전한 이빨 눌림 + 드라마
  socket.on('croc:pressed', async (ev) => {
    lockInput(true);
    updateTurn(null); // 연출 중엔 턴 표시 비움
    if (state.room && state.room.pressed) state.room.pressed[ev.tooth] = true;
    pressToothVisual(ev.tooth, true);
    sfx.press();
    await sleep(140);
    await playDrama(ev.drama, ev.tooth);
    updateProgress();
    lockInput(false);
    updateTurn(ev.nextTurnId);
  });

  // 물기!
  socket.on('croc:bite', async (ev) => {
    if (state.room && state.room.pressed) state.room.pressed[ev.tooth] = true;
    updateTurn(null);
    await playBite(ev);
    if (ev.gameOver) {
      // croc:over 가 뒤따라 결과를 띄운다
    }
  });

  // 서바이벌: 다음 판 리셋
  socket.on('croc:reload', async (ev) => {
    await playReload(ev);
    updateTurn(ev.turnId);
    updateProgress();
  });

  // 최종 결과
  socket.on('croc:over', (ev) => {
    setTimeout(() => showResult(ev), 400);
  });

  // 턴만 바뀜(끊김 등)
  socket.on('croc:turn', (ev) => { if (!state.busy) updateTurn(ev.turnId); });

  socket.on('croc:closed', () => {
    toast('방이 종료되었습니다');
    state.code = null; state.room = null;
    try { history.replaceState(null, '', '/crocodile'); } catch {}
    show('home');
  });

  // 이모지 응원
  socket.on('croc:cheer', (ev) => flyCheer(ev.emoji));
  el('cheer-bar').addEventListener('click', (e) => {
    const b = e.target.closest('.cheer'); if (!b) return;
    socket.emit('croc:cheer', { emoji: b.dataset.e });
  });
  function flyCheer(emoji) {
    const layer = el('cheer-fly');
    const s = document.createElement('div');
    s.className = 'fly'; s.textContent = emoji;
    s.style.left = (10 + Math.random() * 80) + '%';
    s.style.bottom = '80px';
    layer.appendChild(s);
    setTimeout(() => s.remove(), 2300);
  }

  // ═══════════════════════════════════════════════════════════
  //  결과 오버레이
  // ═══════════════════════════════════════════════════════════
  function showResult(ev) {
    const ov = el('result-overlay');
    const isMeLoser = ev.loserId === state.myId;
    const survivorMe = ev.survivorId && ev.survivorId === state.myId;
    if (ev.mode === 'survival' && ev.survivorName) {
      el('result-emoji').textContent = survivorMe ? '👑' : '🏆';
      el('result-title').textContent = '최후의 생존자!';
      el('result-title').className = 'result-title win';
      el('result-name').textContent = ev.survivorName;
      el('result-name').style.color = ev.survivorColor || '#63d29a';
      el('result-sub').textContent = isMeLoser ? '아쉽게 마지막에 물렸어요 😵' : '끝까지 살아남았습니다!';
      confetti(); sfx.win();
    } else {
      el('result-emoji').textContent = isMeLoser ? '😱' : '💀';
      el('result-title').textContent = '당첨!';
      el('result-title').className = 'result-title lose';
      el('result-name').textContent = ev.loserName;
      el('result-name').style.color = ev.loserColor || '#ff5464';
      el('result-sub').textContent = isMeLoser ? '앗! 당신이 물렸어요 🐊' : '악어에게 물렸습니다!';
    }
    // 방장만 다시하기
    const amHost = state.room && state.room.hostId === state.myId && state.role === 'player';
    el('btn-again').style.display = amHost ? '' : 'none';
    ov.classList.add('show');
  }
  function hideResult() { el('result-overlay').classList.remove('show'); }
  el('btn-again').addEventListener('click', () => { hideResult(); socket.emit('croc:again'); });
  el('btn-result-home').addEventListener('click', () => { hideResult(); leaveRoom(); });

  // 소리 토글
  el('btn-sound').addEventListener('click', () => {
    state.sound = !state.sound;
    localStorage.setItem('croc-sound', state.sound ? '1' : '0');
    el('btn-sound').textContent = state.sound ? '🔊' : '🔇';
    if (state.sound) audioReady();
  });
  el('btn-sound').textContent = state.sound ? '🔊' : '🔇';

  // ═══════════════════════════════════════════════════════════
  //  유틸
  // ═══════════════════════════════════════════════════════════
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── 시작 ──
  requestAnimationFrame(rafLoop);
  // 초기 닉네임 채우기
  el('in-name').value = localStorage.getItem('croc-name') || '';
  // 초대링크(?room=CODE) 자동 처리
  const params = new URLSearchParams(location.search);
  const roomParam = (params.get('room') || '').trim().toUpperCase();
  if (roomParam) {
    el('in-code').value = roomParam;
    // 이름이 있으면 바로 입장, 없으면 홈에서 이름 입력 후 입장하도록 코드만 채움
  }

  // 눈 자동 깜빡임 (대기 분위기)
  setInterval(() => { if (state.screen === 'game') blink(); }, 4200);
})();
