/* global Matter, PinballComponents */
/**
 * 브라우저 데모 — 서버 없이 이 페이지 안에서만 도는 낙하 레이스.
 * 실제 게임과 같은 물리 상수(중력 1.05, 공 r=7, 배속 서브스텝)와
 * 같은 기본 맵(클래식/스피너 파크)을 사용한다.
 */
(() => {
  const { WORLD, buildShapes } = PinballComponents;
  const VIEW = { width: 600, height: 760 };
  const TICK_MS = 1000 / 60;
  const TIME_SCALE = 5; // 실제 게임 기본값과 동일한 낙하 배속 (server/config.js)
  const GOAL_MARGIN = 55;
  const $ = (id) => document.getElementById(id);

  // ── 서버와 동일한 기본 맵 정의 (server/maps.js) ──────────
  const peg = (x, y, size = 8) => ({ type: 'peg', x, y, props: { size } });
  function funnel() {
    const H = WORLD.height;
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
    pegRow(comps, 170);
    pegRow(comps, 222, 27);
    comps.push({ type: 'bumper', x: 300, y: 320, props: { size: 24 } });
    comps.push({ type: 'bumper', x: 110, y: 385, props: { size: 18 } });
    comps.push({ type: 'bumper', x: 490, y: 385, props: { size: 18 } });
    comps.push({ type: 'spinner', x: 170, y: 530, props: { length: 160, speed: 4 } });
    comps.push({ type: 'spinner', x: 430, y: 530, props: { length: 160, speed: -4 } });
    comps.push({ type: 'cross', x: 300, y: 690, props: { length: 150, speed: 3 } });
    comps.push({ type: 'bomb', x: 60, y: 690, props: { radius: 150, power: 14, respawn: 6 } });
    comps.push({ type: 'bomb', x: 540, y: 690, props: { radius: 150, power: 14, respawn: 6 } });
    pegRow(comps, 830);
    pegRow(comps, 882, 27);
    comps.push({ type: 'wall', x: 120, y: 1000, props: { length: 200, angle: 35 } });
    comps.push({ type: 'wall', x: 480, y: 1000, props: { length: 200, angle: -35 } });
    comps.push({ type: 'bumper', x: 300, y: 1020, props: { size: 20 } });
    comps.push({ type: 'spinner', x: 300, y: 1170, props: { length: 220, speed: 5 } });
    comps.push({ type: 'bumper', x: 85, y: 1170, props: { size: 16 } });
    comps.push({ type: 'bumper', x: 515, y: 1170, props: { size: 16 } });
    comps.push({ type: 'cross', x: 170, y: 1350, props: { length: 130, speed: -4 } });
    comps.push({ type: 'cross', x: 430, y: 1350, props: { length: 130, speed: 4 } });
    pegRow(comps, 1490);
    pegRow(comps, 1542, 27);
    comps.push({ type: 'wall', x: 180, y: 1670, props: { length: 280, angle: 20 } });
    comps.push({ type: 'wall', x: 420, y: 1820, props: { length: 280, angle: -20 } });
    comps.push({ type: 'spinner', x: 150, y: 1975, props: { length: 150, speed: -6 } });
    comps.push({ type: 'spinner', x: 450, y: 1975, props: { length: 150, speed: 6 } });
    comps.push({ type: 'bomb', x: 300, y: 2080, props: { radius: 180, power: 16, respawn: 5 } });
    pegRow(comps, 2170);
    return [...comps, ...funnel()];
  }
  const MAPS = {
    classic: { name: '클래식', components: classicComponents() },
    spinner: { name: '스피너 파크', components: spinnerParkComponents() },
  };

  // 주얼 톤 8색 (실제 게임의 플레이어 팔레트)
  const BALLS = [
    { name: '가넷', color: '#b23a48' },
    { name: '샴페인', color: '#d4b06a' },
    { name: '진주', color: '#e9e4d6' },
    { name: '에메랄드', color: '#2f8f6b' },
    { name: '사파이어', color: '#4a7fc1' },
    { name: '자수정', color: '#8a63c0' },
    { name: '은', color: '#a7b0ba' },
    { name: '구리', color: '#c07a3e' },
  ];

  // ── 상태 ──────────────────────────────────────────────
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const mCanvas = $('minimap');
  const mCtx = mCanvas.getContext('2d');
  let sim = null; // { engine, balls[], comps[], spinners[], bombs, ... }
  let currentMap = 'classic';

  function setupCanvases() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.min(600, window.innerWidth - 32);
    const cssH = VIEW.height * (cssW / VIEW.width);
    canvas.width = VIEW.width * dpr;
    canvas.height = VIEW.height * dpr;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mw = 74;
    mCanvas.width = mw * dpr;
    mCanvas.height = mw * (WORLD.height / WORLD.width) * dpr;
    mCanvas.style.width = mw + 'px';
    mCanvas.style.height = mw * (WORLD.height / WORLD.width) * 0.42 + 'px';
    mCtx.setTransform(
      (mw / WORLD.width) * dpr,
      0, 0,
      ((mw * (WORLD.height / WORLD.width)) / WORLD.height) * dpr,
      0, 0
    );
  }

  // ── 보드 구성 (server/board.js 와 동일한 로직) ─────────
  function buildSim(mapId) {
    const engine = Matter.Engine.create();
    engine.gravity.y = 1.05;
    engine.positionIterations = 10;
    engine.velocityIterations = 8;

    const H = WORLD.height;
    const goalY = H - GOAL_MARGIN;
    const bodies = [
      Matter.Bodies.rectangle(-10, H / 2, 20, H * 4, { isStatic: true }),
      Matter.Bodies.rectangle(WORLD.width + 10, H / 2, 20, H * 4, { isStatic: true }),
      Matter.Bodies.rectangle(WORLD.width / 2, -10, WORLD.width * 2, 20, { isStatic: true }),
    ];

    const comps = [];
    const spinners = [];
    const bombs = new Map(); // bodyId -> {index, x, y, hit, exploded, respawnAt, body}
    for (const c of MAPS[mapId].components) {
      const built = buildShapes(c.type, c.props);
      if (!built) continue;
      const opts = { isStatic: true, restitution: built.restitution };
      const parts = built.shapes.map((s) =>
        s.kind === 'circle'
          ? Matter.Bodies.circle(c.x + s.x, c.y + s.y, s.r, opts)
          : Matter.Bodies.rectangle(c.x + s.x, c.y + s.y, s.w, s.h, { ...opts, angle: s.angle || 0 })
      );
      const body = parts.length === 1 ? parts[0] : Matter.Body.create({ parts, isStatic: true });
      bodies.push(body);
      if (built.spin) spinners.push({ body, spin: built.spin, pivot: { x: c.x, y: c.y }, angle: 0 });
      if (built.hit) {
        bombs.set(body.id, { index: comps.length, body, x: c.x, y: c.y, hit: built.hit, exploded: false, respawnAt: 0 });
      }
      comps.push({ type: c.type, x: c.x, y: c.y, shapes: built.shapes, spin: built.spin || 0 });
    }

    const balls = BALLS.map((meta, i) => {
      const body = Matter.Bodies.circle(80 + i * 63, 76, 7, {
        restitution: 0.7,
        friction: 0.02,
        frictionAir: 0.004,
        density: 0.0015,
      });
      body.plugin = { meta, done: false };
      bodies.push(body);
      return body;
    });

    Matter.Composite.add(engine.world, bodies);

    // 폭탄 충돌 → 폭발 (실제 게임의 HIT_ACTIONS.explode)
    Matter.Events.on(engine, 'collisionStart', (ev) => {
      for (const pair of ev.pairs) {
        for (const [a, b] of [[pair.bodyA, pair.bodyB], [pair.bodyB, pair.bodyA]]) {
          const inst = bombs.get((a.parent || a).id);
          const ball = b.parent || b;
          if (!inst || inst.exploded || !ball.plugin || !ball.plugin.meta) continue;
          inst.exploded = true;
          inst.respawnAt = sim.simMs + (inst.hit.respawnMs > 0 ? inst.hit.respawnMs : Infinity);
          Matter.Composite.remove(engine.world, inst.body);
          for (const other of balls) {
            if (other.plugin.done) continue;
            const dx = other.position.x - inst.x;
            const dy = other.position.y - inst.y;
            const dist = Math.hypot(dx, dy);
            if (dist > inst.hit.radius) continue;
            const v = inst.hit.power * (0.45 + 0.55 * (1 - dist / inst.hit.radius));
            Matter.Body.setVelocity(other, {
              x: other.velocity.x * 0.25 + (dist > 1 ? dx / dist : 0) * v,
              y: other.velocity.y * 0.25 + (dist > 1 ? dy / dist : -1) * v,
            });
          }
          sim.explosions.push({ x: inst.x, y: inst.y, radius: inst.hit.radius, start: performance.now() });
        }
      }
    });

    return {
      engine, balls, comps, spinners, bombs, goalY,
      simMs: 0, dropped: false, dropSimMs: 0,
      finished: [], explosions: [], camY: 0,
      shuffleTargets: balls.map((b) => ({ x: b.position.x, y: b.position.y })),
      nextShuffleAt: 0,
    };
  }

  // ── 셔플 & 낙하 ───────────────────────────────────────
  const PATTERNS = [
    (n) => Array.from({ length: n }, (_, i) => ({ x: 70 + (460 / Math.max(n - 1, 1)) * i, y: 76 })),
    (n) => Array.from({ length: n }, (_, i) => ({ x: 70 + (460 / Math.max(n - 1, 1)) * i, y: 56 + (i % 2) * 42 })),
    (n) => Array.from({ length: n }, (_, i) => {
      const a = (Math.PI * 2 * i) / n;
      return { x: 300 + Math.cos(a) * 190, y: 72 + Math.sin(a) * 34 };
    }),
    (n) => Array.from({ length: n }, () => ({ x: 50 + Math.random() * 500, y: 40 + Math.random() * 68 })),
  ];

  function reset(mapId) {
    currentMap = mapId;
    sim = buildSim(mapId);
    $('rank-list').innerHTML = '';
    $('btn-drop').textContent = '🎲 지금 떨어뜨리기!';
    $('btn-drop').disabled = false;
    $('map-classic').classList.toggle('selected', mapId === 'classic');
    $('map-spinner').classList.toggle('selected', mapId === 'spinner');
  }

  function tick() {
    if (!sim.dropped) {
      // 셔플: 실시간 1배속 — 배치 패턴 사이를 부드럽게 이동
      sim.simMs += TICK_MS;
      const now = performance.now();
      if (now >= sim.nextShuffleAt) {
        sim.shuffleTargets = PATTERNS[Math.floor(Math.random() * PATTERNS.length)](sim.balls.length);
        sim.nextShuffleAt = now + 1600;
      }
      sim.balls.forEach((ball, i) => {
        const t = sim.shuffleTargets[i];
        Matter.Body.setVelocity(ball, { x: 0, y: 0 });
        Matter.Body.setPosition(ball, {
          x: ball.position.x + (t.x - ball.position.x) * 0.12,
          y: ball.position.y + (t.y - ball.position.y) * 0.12,
        });
      });
      rotateSpinners();
      Matter.Engine.update(sim.engine, TICK_MS);
      return;
    }
    // 낙하: 10배속 서브스텝 (실제 게임과 동일)
    for (let s = 0; s < TIME_SCALE; s++) {
      sim.simMs += TICK_MS;
      rotateSpinners();
      // 폭탄 재생성
      for (const inst of sim.bombs.values()) {
        if (inst.exploded && sim.simMs >= inst.respawnAt) {
          inst.exploded = false;
          Matter.Composite.add(sim.engine.world, inst.body);
        }
      }
      Matter.Engine.update(sim.engine, TICK_MS);
      // 도착 판정
      for (const ball of sim.balls) {
        if (!ball.plugin.done && ball.position.y > sim.goalY) {
          ball.plugin.done = true;
          Matter.Composite.remove(sim.engine.world, ball);
          sim.finished.push({ meta: ball.plugin.meta, timeMs: sim.simMs - sim.dropSimMs });
          appendRank(sim.finished.length, ball.plugin.meta, sim.simMs - sim.dropSimMs);
        }
      }
    }
    if (sim.balls.every((b) => b.plugin.done)) {
      $('btn-drop').textContent = '🔄 다시 떨어뜨리기';
      $('btn-drop').disabled = false;
      sim.dropped = false;
      sim.over = true;
    }
  }

  function rotateSpinners() {
    for (const sp of sim.spinners) {
      sp.angle += (sp.spin * TICK_MS) / 1000;
      Matter.Body.setAngle(sp.body, sp.angle);
      Matter.Body.setPosition(sp.body, sp.pivot);
    }
  }

  function appendRank(rank, meta, timeMs) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="num">${rank}</span><span class="dot" style="background:${meta.color}"></span><span>${meta.name}</span><span class="time">${(timeMs / 1000).toFixed(1)}초</span>`;
    $('rank-list').appendChild(li);
  }

  // ── 렌더링 ────────────────────────────────────────────
  function drawComponent(c, comp, angle, flat) {
    c.save();
    c.translate(comp.x, comp.y);
    if (angle) c.rotate(angle);
    for (const s of comp.shapes) {
      const color = s.fill || '#35e0ff';
      if (!flat) {
        c.shadowColor = s.glow || color;
        c.shadowBlur = 13;
      }
      c.fillStyle = flat ? s.glow || color : color;
      if (s.kind === 'circle') {
        c.beginPath();
        c.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        c.fill();
        if (!flat && s.r >= 5) {
          c.shadowBlur = 0;
          c.beginPath();
          c.arc(s.x, s.y, s.r * 0.45, 0, Math.PI * 2);
          c.fillStyle = 'rgba(255,255,255,0.35)';
          c.fill();
        }
      } else {
        c.save();
        c.translate(s.x, s.y);
        c.rotate(s.angle || 0);
        c.fillRect(-s.w / 2, -s.h / 2, s.w, s.h);
        if (!flat && s.h >= 8) {
          c.shadowBlur = 0;
          c.fillStyle = 'rgba(255,255,255,0.30)';
          c.fillRect(-s.w / 2 + 2, -1, s.w - 4, 2);
        }
        c.restore();
      }
      c.shadowBlur = 0;
    }
    c.restore();
  }

  function render() {
    // 카메라: 선두 공을 따라 내려감
    let lead = 0;
    for (const b of sim.balls) if (!b.plugin.done && b.position.y > lead) lead = b.position.y;
    const targetCam = Math.min(Math.max(lead - VIEW.height * 0.42, 0), WORLD.height - VIEW.height);
    sim.camY += (targetCam - sim.camY) * 0.1;

    ctx.clearRect(0, 0, VIEW.width, VIEW.height);
    ctx.save();
    ctx.translate(0, -sim.camY);

    // 골인선
    const goal = { x: 300, y: sim.goalY, width: 236 };
    const cols = 20;
    const sq = goal.width / cols;
    for (let r = 0; r < 2; r++)
      for (let i = 0; i < cols; i++) {
        ctx.fillStyle = (i + r) % 2 === 0 ? 'rgba(220,215,200,0.55)' : 'rgba(20,20,24,0.9)';
        ctx.fillRect(goal.x - goal.width / 2 + i * sq, goal.y + r * sq, sq, sq);
      }
    ctx.save();
    ctx.shadowColor = '#35e0ff';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = 'rgba(53,224,255,0.8)';
    ctx.beginPath();
    ctx.moveTo(goal.x - goal.width / 2, goal.y);
    ctx.lineTo(goal.x + goal.width / 2, goal.y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(235,250,255,0.92)';
    ctx.font = "15px 'Bebas Neue', 'Gothic A1', sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText('F I N I S H', goal.x, goal.y - 10);
    ctx.restore();

    // 구성요소
    sim.comps.forEach((comp, i) => {
      const bombInst = [...sim.bombs.values()].find((x) => x.index === i);
      if (bombInst && bombInst.exploded) return;
      const sp = sim.spinners.find((x) => x.pivot.x === comp.x && x.pivot.y === comp.y && comp.spin);
      drawComponent(ctx, comp, sp ? sp.angle : 0, false);
    });

    // 공 — 발광 구슬
    for (const ball of sim.balls) {
      if (ball.plugin.done) continue;
      const { x, y } = ball.position;
      ctx.shadowColor = ball.plugin.meta.color;
      ctx.shadowBlur = 11;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = ball.plugin.meta.color;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(x - 1.4, y - 1.7, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fill();
    }

    // 폭발 링
    const now = performance.now();
    sim.explosions = sim.explosions.filter((e) => now - e.start < 450);
    for (const e of sim.explosions) {
      const p = (now - e.start) / 450;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.radius * p, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(201,143,51,${1 - p})`;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.restore();

    // 미니맵
    mCtx.clearRect(0, 0, WORLD.width, WORLD.height);
    for (const comp of sim.comps) drawComponent(mCtx, comp, 0, true);
    mCtx.fillStyle = 'rgba(212,175,55,0.7)';
    mCtx.fillRect(goal.x - goal.width / 2, sim.goalY, goal.width, 14);
    for (const ball of sim.balls) {
      if (ball.plugin.done) continue;
      mCtx.beginPath();
      mCtx.arc(ball.position.x, ball.position.y, 16, 0, Math.PI * 2);
      mCtx.fillStyle = ball.plugin.meta.color;
      mCtx.fill();
    }
    mCtx.strokeStyle = 'rgba(232,228,218,0.6)';
    mCtx.lineWidth = 8;
    mCtx.strokeRect(2, sim.camY, WORLD.width - 4, VIEW.height);
  }

  // ── 루프 & 이벤트 ─────────────────────────────────────
  function frame() {
    tick();
    render();
    requestAnimationFrame(frame);
  }

  $('btn-drop').addEventListener('click', () => {
    if (sim.over) return reset(currentMap);
    sim.dropped = true;
    sim.dropSimMs = sim.simMs;
    $('btn-drop').disabled = true;
  });
  $('map-classic').addEventListener('click', () => reset('classic'));
  $('map-spinner').addEventListener('click', () => reset('spinner'));

  // 서버 링크 (config.js)
  if (window.PINBALL_SERVER_URL) {
    const btn = $('btn-play');
    btn.href = window.PINBALL_SERVER_URL;
    btn.classList.remove('hidden');
    $('server-note').textContent = '※ 이 페이지의 데모는 혼자 보는 시뮬레이션입니다 — 친구와의 진짜 승부는 위 버튼으로!';
  }

  setupCanvases();
  window.addEventListener('resize', setupCanvases);
  reset('classic');
  requestAnimationFrame(frame);
})();
