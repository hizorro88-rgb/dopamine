/* global io, PinballComponents */
(() => {
  const socket = io();
  const { WORLD, COMPONENTS, defaultProps, buildShapes } = PinballComponents;

  // 화면에 보이는 뷰포트 크기 (월드는 세로로 훨씬 길다 → 카메라가 따라감)
  const VIEW = { width: 600, height: 900 };
  const EDIT_BOUNDS = { minX: 25, maxX: 575, minY: 130, maxY: WORLD.height - 100 };

  // ── 상태 ──────────────────────────────────────────────
  let myId = null;
  let room = null; // room:update 페이로드
  let game = null; // { board, players(Map), items, snapshots[], ... }
  const $ = (id) => document.getElementById(id);

  socket.on('connect', () => {
    myId = socket.id;
  });

  // ── 화면 전환 ─────────────────────────────────────────
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(`screen-${name}`).classList.add('active');
    editor.active = name === 'editor';
    if (editor.active) requestAnimationFrame(renderEditor);
  }

  // ── 공용: 구성요소 도형 렌더러 ─────────────────────────
  // 서버가 내려준 shapes 를 그대로 그린다. 새 구성요소가 추가돼도 수정 불필요.
  function drawComponent(ctx, comp, angle) {
    ctx.save();
    ctx.translate(comp.x, comp.y);
    if (angle) ctx.rotate(angle);
    for (const s of comp.shapes) {
      ctx.fillStyle = s.fill || '#565685';
      if (s.kind === 'circle') {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(s.angle || 0);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-s.w / 2, -s.h / 2, s.w, s.h, 5);
        else ctx.rect(-s.w / 2, -s.h / 2, s.w, s.h);
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  function drawGoal(ctx, goal) {
    const grad = ctx.createLinearGradient(0, goal.y - 60, 0, goal.y + 20);
    grad.addColorStop(0, 'rgba(93,222,120,0)');
    grad.addColorStop(1, 'rgba(93,222,120,0.35)');
    ctx.fillStyle = grad;
    ctx.fillRect(goal.x - goal.width / 2, goal.y - 60, goal.width, 75);
    ctx.fillStyle = '#5dde78';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('GOAL', goal.x, goal.y + 8);
  }

  /**
   * 미니맵 렌더러 (게임/에디터 공용)
   * 전체 월드를 축소해 구성요소·공·현재 화면 영역을 표시한다.
   */
  function drawMinimap(mCanvas, { components, balls, camY, elapsed, selected }) {
    const mctx = mCanvas.getContext('2d');
    const s = mCanvas.width / WORLD.width;
    mctx.setTransform(s, 0, 0, s, 0, 0);
    mctx.clearRect(0, 0, WORLD.width, WORLD.height);

    // 골인 지점
    mctx.fillStyle = 'rgba(93,222,120,0.3)';
    mctx.fillRect(0, WORLD.height - 70, WORLD.width, 70);

    // 구성요소 (회전체는 실제 각도로)
    for (const comp of components) {
      drawComponent(mctx, comp, comp.spin ? comp.spin * elapsed : 0);
    }

    // 선택된 구성요소 강조 (에디터)
    if (selected) {
      mctx.strokeStyle = '#5dde78';
      mctx.lineWidth = 12;
      mctx.beginPath();
      mctx.arc(selected.x, selected.y, 44, 0, Math.PI * 2);
      mctx.stroke();
    }

    // 공 (미니맵에서 보이도록 확대)
    if (balls) {
      for (const b of balls) {
        mctx.beginPath();
        mctx.arc(b.x, b.y, b.mine ? 34 : 26, 0, Math.PI * 2);
        mctx.fillStyle = b.color;
        mctx.fill();
        if (b.mine) {
          mctx.strokeStyle = '#ffffff';
          mctx.lineWidth = 10;
          mctx.stroke();
        }
      }
    }

    // 현재 화면 영역
    mctx.strokeStyle = 'rgba(255,255,255,0.75)';
    mctx.lineWidth = 10;
    mctx.strokeRect(5, camY + 5, WORLD.width - 10, VIEW.height - 10);
  }

  function setupMinimapCanvas(mCanvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = 90; // CSS 픽셀 기준 내부 해상도
    mCanvas.width = w * dpr;
    mCanvas.height = w * (WORLD.height / WORLD.width) * dpr;
  }

  const clampCam = (y) => Math.min(Math.max(y, 0), WORLD.height - VIEW.height);

  // ── 홈: 방 만들기 / 참여 ──────────────────────────────
  const inputName = $('input-name');
  const inputCode = $('input-code');
  const homeError = $('home-error');

  // 초대 링크(?room=CODE)로 들어온 경우 코드 자동 입력
  const urlCode = new URLSearchParams(location.search).get('room');
  if (urlCode) inputCode.value = urlCode.toUpperCase();

  inputName.value = localStorage.getItem('pinball-name') || '';

  function myName() {
    const name = inputName.value.trim() || '플레이어';
    localStorage.setItem('pinball-name', name);
    return name;
  }

  $('btn-create').addEventListener('click', () => {
    socket.emit('room:create', { name: myName() }, (res) => {
      if (!res.ok) homeError.textContent = res.error || '방 생성 실패';
    });
  });

  $('btn-join').addEventListener('click', joinRoom);
  inputCode.addEventListener('keydown', (e) => e.key === 'Enter' && joinRoom());

  function joinRoom() {
    const code = inputCode.value.trim().toUpperCase();
    if (!code) return (homeError.textContent = '초대 코드를 입력해주세요.');
    socket.emit('room:join', { code, name: myName() }, (res) => {
      if (!res.ok) homeError.textContent = res.error || '입장 실패';
    });
  }

  // ── 대기실 ────────────────────────────────────────────
  let mapList = []; // maps:list 캐시

  socket.on('room:update', (data) => {
    room = data;
    if (room.state === 'lobby' && !game && !editor.active) {
      renderLobby();
      showScreen('lobby');
    } else if (room.state === 'lobby') {
      renderLobby();
    }
  });

  function renderLobby() {
    $('lobby-code').textContent = room.code;
    const list = $('lobby-players');
    list.innerHTML = '';
    for (const p of room.players) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="player-dot" style="background:${p.color}"></span>
        <span>${escapeHtml(p.name)}${p.id === myId ? ' (나)' : ''}</span>
        ${p.id === room.hostId ? '<span class="host-badge">👑 방장</span>' : ''}`;
      list.appendChild(li);
    }
    const isHost = room.hostId === myId;
    const startBtn = $('btn-start');
    startBtn.disabled = !isHost;
    startBtn.textContent = isHost ? '🚀 게임 시작' : '⏳ 방장이 시작하기를 기다리는 중';
    $('lobby-hint').textContent = `${room.players.length}/${room.maxPlayers}명 · 시작하면 각자 랜덤 아이템 2개를 받아요!`;
    refreshMaps();
  }

  function refreshMaps() {
    socket.emit('maps:list', null, (res) => {
      if (!res || !res.ok || !room) return;
      mapList = res.maps;
      const select = $('map-select');
      select.innerHTML = '';
      for (const m of mapList) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.builtin ? '⭐' : '🛠'} ${m.name} — ${m.author}`;
        select.appendChild(opt);
      }
      select.value = room.map ? room.map.id : 'classic';
      select.disabled = room.hostId !== myId;
      const meta = mapList.find((m) => m.id === select.value);
      $('map-info').textContent = meta
        ? `구성요소 ${meta.count}개 · ${room.hostId === myId ? '맵을 선택하세요' : '방장이 맵을 선택합니다'}`
        : '';
    });
  }

  $('map-select').addEventListener('change', (e) => {
    socket.emit('room:setMap', { mapId: e.target.value });
  });

  $('btn-copy').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?room=${room.code}`;
    try {
      await navigator.clipboard.writeText(url);
      $('btn-copy').textContent = '✅ 복사 완료!';
    } catch {
      prompt('아래 링크를 복사해서 친구에게 보내주세요:', url);
    }
    setTimeout(() => ($('btn-copy').textContent = '🔗 초대 링크 복사'), 1500);
  });

  $('btn-start').addEventListener('click', () => socket.emit('game:start'));

  // ── 게임 시작 ─────────────────────────────────────────
  socket.on('game:started', ({ board, players, yourItems, countdownMs }) => {
    game = {
      board,
      players: new Map(players.map((p) => [p.id, p])),
      items: yourItems, // [{id,name,emoji,desc,target,duration} | null]
      snapshots: [],
      countdown: countdownMs,
      finishedRanks: [],
      overShown: false,
      camY: 0,
    };
    $('rank-list').innerHTML = '';
    $('toast-area').innerHTML = '';
    $('result-modal').classList.add('hidden');
    $('target-modal').classList.add('hidden');
    renderItems();
    setupCanvas();
    showScreen('game');
    requestAnimationFrame(renderFrame);
  });

  socket.on('game:snapshot', (snap) => {
    if (!game) return;
    snap.recv = performance.now();
    game.snapshots.push(snap);
    if (game.snapshots.length > 4) game.snapshots.shift();
    game.countdown = snap.countdown;
  });

  socket.on('game:ballFinished', ({ playerId, name, rank }) => {
    if (!game) return;
    game.finishedRanks.push({ playerId, name, rank });
    const p = game.players.get(playerId);
    const li = document.createElement('li');
    li.innerHTML = `<span class="rank-num">${rank}등</span>
      <span class="player-dot" style="background:${p ? p.color : '#888'}"></span>
      <span>${escapeHtml(name)}${playerId === myId ? ' (나)' : ''}</span>`;
    $('rank-list').appendChild(li);
    if (rank === 1) toast(`🏆 ${name}님이 1등으로 도착!`);
  });

  socket.on('game:itemUsed', ({ by, item, target, self }) => {
    toast(
      self
        ? `${item.emoji} ${by} → ${item.name} 사용!`
        : `${item.emoji} ${by} → ${target}에게 ${item.name}!`
    );
  });

  socket.on('game:over', ({ ranking }) => {
    if (!game) return;
    game.overShown = true;
    const list = $('result-list');
    list.innerHTML = '';
    const medals = ['🥇', '🥈', '🥉'];
    for (const r of ranking) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="rank-num">${medals[r.rank - 1] || r.rank + '등'}</span>
        <span class="player-dot" style="background:${r.color}"></span>
        <span>${escapeHtml(r.name)}${r.playerId === myId ? ' (나)' : ''}</span>
        ${r.finished ? '' : '<span style="margin-left:auto;font-size:12px;color:var(--muted)">미도착</span>'}`;
      list.appendChild(li);
    }
    $('result-modal').classList.remove('hidden');
  });

  $('btn-back-lobby').addEventListener('click', () => {
    $('result-modal').classList.add('hidden');
    game = null;
    if (room) {
      renderLobby();
      showScreen('lobby');
    }
  });

  socket.on('disconnect', () => {
    room = null;
    game = null;
    homeError.textContent = '서버와의 연결이 끊어졌습니다. 새로고침 해주세요.';
    showScreen('home');
  });

  // ── 아이템 UI ─────────────────────────────────────────
  function renderItems() {
    const slots = $('item-slots');
    slots.innerHTML = '';
    game.items.forEach((item, i) => {
      const div = document.createElement('div');
      div.className = 'item-slot' + (item ? '' : ' used');
      if (item) {
        div.title = item.desc;
        div.innerHTML = `<span class="emoji">${item.emoji}</span><span class="label">${item.name}</span>`;
        div.addEventListener('click', () => onItemClick(i));
      } else {
        div.innerHTML = `<span class="emoji">✔️</span><span class="label">사용함</span>`;
      }
      slots.appendChild(div);
    });
  }

  function onItemClick(slotIndex) {
    const item = game.items[slotIndex];
    if (!item) return;
    if (item.target === 'opponent') {
      openTargetModal(slotIndex, item);
    } else {
      useItem(slotIndex, null);
    }
  }

  function useItem(slotIndex, targetId) {
    socket.emit('game:useItem', { slotIndex, targetId }, (res) => {
      if (res && !res.ok) {
        toast(`⚠️ ${res.error}`);
        return;
      }
      game.items[slotIndex] = null;
      renderItems();
    });
  }

  function openTargetModal(slotIndex, item) {
    const finished = new Set(game.finishedRanks.map((f) => f.playerId));
    const targets = [...game.players.values()].filter(
      (p) => p.id !== myId && !finished.has(p.id)
    );
    if (targets.length === 0) return toast('⚠️ 사용할 수 있는 대상이 없습니다.');

    $('target-title').textContent = `${item.emoji} ${item.name} — 누구에게 쓸까요?`;
    const list = $('target-list');
    list.innerHTML = '';
    for (const p of targets) {
      const btn = document.createElement('button');
      btn.className = 'btn target-btn';
      btn.innerHTML = `<span class="player-dot" style="background:${p.color}"></span>${escapeHtml(p.name)}`;
      btn.addEventListener('click', () => {
        $('target-modal').classList.add('hidden');
        useItem(slotIndex, p.id);
      });
      list.appendChild(btn);
    }
    $('target-modal').classList.remove('hidden');
  }

  $('btn-target-cancel').addEventListener('click', () =>
    $('target-modal').classList.add('hidden')
  );

  function toast(msg) {
    const area = $('toast-area');
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = msg;
    area.prepend(div);
    while (area.children.length > 4) area.lastChild.remove();
    setTimeout(() => div.remove(), 4000);
  }

  // ── 게임 캔버스 렌더링 ────────────────────────────────
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const minimap = $('minimap');
  let scale = 1;

  function setupCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = VIEW.width * dpr;
    canvas.height = VIEW.height * dpr;
    scale = dpr;
    setupMinimapCanvas(minimap);
  }

  // 스냅샷 보간: 마지막 두 스냅샷 사이를 부드럽게 이동
  function interpolatedBalls() {
    const snaps = game.snapshots;
    if (snaps.length === 0) return [];
    if (snaps.length === 1) return snaps[0].balls;

    const prev = snaps[snaps.length - 2];
    const curr = snaps[snaps.length - 1];
    const span = Math.max(curr.recv - prev.recv, 1);
    const alpha = Math.min((performance.now() - curr.recv) / span, 1);

    return curr.balls.map((b) => {
      const pb = prev.balls.find((x) => x.p === b.p);
      if (!pb) return b;
      return {
        ...b,
        x: pb.x + (b.x - pb.x) * alpha,
        y: pb.y + (b.y - pb.y) * alpha,
      };
    });
  }

  /** 회전 구성요소의 현재 각도 계산용 경과 시간(초) */
  function gameElapsedSec() {
    const snaps = game.snapshots;
    if (snaps.length === 0) return 0;
    const last = snaps[snaps.length - 1];
    return (last.elapsed + (performance.now() - last.recv)) / 1000;
  }

  function renderFrame() {
    if (!game) return;
    const { board } = game;
    const balls = interpolatedBalls();
    const elapsed = gameElapsedSec();

    // 카메라: 내 공을 따라감. 내 공이 도착하면 선두(가장 아래) 공을 따라감.
    const mine = balls.find((b) => b.p === myId);
    const focus = mine || balls.reduce((a, b) => (!a || b.y > a.y ? b : a), null);
    if (focus) {
      const target = clampCam(focus.y - VIEW.height * 0.42);
      game.camY += (target - game.camY) * 0.08;
    }
    const camY = game.camY;

    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, VIEW.width, VIEW.height);
    ctx.save();
    ctx.translate(0, -camY);

    drawGoal(ctx, board.goal);

    // 맵 구성요소 (화면 근처만 그리기, 회전체는 경과 시간으로 각도 계산 → 서버와 동기화)
    for (const comp of board.components) {
      if (comp.y < camY - 300 || comp.y > camY + VIEW.height + 300) continue;
      drawComponent(ctx, comp, comp.spin ? comp.spin * elapsed : 0);
    }

    // 공
    const r = board.ballRadius;
    for (const b of balls) {
      const p = game.players.get(b.p);
      const color = p ? p.color : '#888';
      const radius = b.b ? r * 1.6 : r;

      ctx.save();
      if (b.g) ctx.globalAlpha = 0.45; // 유령 상태

      ctx.beginPath();
      ctx.arc(b.x, b.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;

      // 하이라이트
      ctx.beginPath();
      ctx.arc(b.x - radius * 0.3, b.y - radius * 0.3, radius * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fill();
      ctx.restore();

      // 상태 이모지
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      if (b.f) ctx.fillText('🧊', b.x, b.y + 5);
      if (b.g) ctx.fillText('👻', b.x, b.y + 5);

      // 이름표
      ctx.font = 'bold 12px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText(
        (p ? p.name : '?') + (b.p === myId ? ' ★' : ''),
        b.x,
        b.y - radius - 6
      );
    }

    ctx.restore();

    // 미니맵
    drawMinimap(minimap, {
      components: board.components,
      balls: balls.map((b) => {
        const p = game.players.get(b.p);
        return { x: b.x, y: b.y, color: p ? p.color : '#888', mine: b.p === myId };
      }),
      camY,
      elapsed,
    });

    // 카운트다운
    const cd = game.countdown;
    $('countdown').textContent =
      cd > 0 ? String(Math.ceil(cd / 1000)) : game.snapshots.length ? '' : '준비...';

    requestAnimationFrame(renderFrame);
  }

  // ── 맵 에디터 ─────────────────────────────────────────
  const editor = {
    active: false,
    comps: [], // [{type, x, y, props, shapes, spin}]
    tool: 'peg', // 팔레트에서 선택된 구성요소 타입
    selected: -1, // 선택된 comps 인덱스
    dragging: false,
    camY: 0,
  };

  const eCanvas = $('editor-canvas');
  const eCtx = eCanvas.getContext('2d');
  const eMinimap = $('editor-minimap');
  let eScale = 1;

  function setupEditorCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    eCanvas.width = VIEW.width * dpr;
    eCanvas.height = VIEW.height * dpr;
    eScale = dpr;
    setupMinimapCanvas(eMinimap);
  }

  function rebuildComp(comp) {
    const built = buildShapes(comp.type, comp.props);
    comp.shapes = built.shapes;
    comp.spin = built.spin;
  }

  function openEditor() {
    editor.comps = [];
    editor.selected = -1;
    editor.tool = 'peg';
    editor.camY = 0;
    $('input-map-name').value = '';
    $('editor-msg').textContent = '';
    renderPalette();
    renderPropsPanel();
    setupEditorCanvas();
    showScreen('editor');
  }

  $('btn-open-editor').addEventListener('click', openEditor);
  $('btn-editor-back').addEventListener('click', () => {
    if (room) {
      renderLobby();
      showScreen('lobby');
    } else {
      showScreen('home');
    }
  });

  function renderPalette() {
    const palette = $('palette');
    palette.innerHTML = '';
    for (const def of Object.values(COMPONENTS)) {
      const btn = document.createElement('button');
      btn.className = 'palette-btn' + (editor.tool === def.id ? ' selected' : '');
      btn.title = def.desc;
      btn.innerHTML = `<span class="emoji">${def.emoji}</span>${def.name}`;
      btn.addEventListener('click', () => {
        editor.tool = def.id;
        editor.selected = -1;
        renderPalette();
        renderPropsPanel();
      });
      palette.appendChild(btn);
    }
  }

  /** 선택된 구성요소의 속성 슬라이더 */
  function renderPropsPanel() {
    const panel = $('editor-props');
    panel.innerHTML = '';
    $('btn-comp-delete').disabled = editor.selected < 0;

    const comp = editor.comps[editor.selected];
    if (!comp) {
      const def = COMPONENTS[editor.tool];
      panel.innerHTML = `<div class="prop-row">배치할 요소: ${def.emoji} ${def.name}<br>${def.desc}</div>`;
      return;
    }
    const def = COMPONENTS[comp.type];
    const title = document.createElement('div');
    title.className = 'prop-row';
    title.textContent = `선택됨: ${def.emoji} ${def.name}`;
    panel.appendChild(title);

    for (const schema of def.props) {
      const row = document.createElement('div');
      row.className = 'prop-row';
      const label = document.createElement('span');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = schema.min;
      input.max = schema.max;
      input.step = schema.step;
      input.value = comp.props[schema.key];
      const setLabel = () => (label.textContent = `${schema.label}: ${input.value}`);
      setLabel();
      input.addEventListener('input', () => {
        comp.props[schema.key] = Number(input.value);
        rebuildComp(comp);
        setLabel();
      });
      row.appendChild(label);
      row.appendChild(input);
      panel.appendChild(row);
    }
  }

  // 캔버스 좌표 변환 (에디터 카메라 반영)
  function eventToWorld(e) {
    const rect = eCanvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * VIEW.width,
      y: ((e.clientY - rect.top) / rect.height) * VIEW.height + editor.camY,
    };
  }

  function clampToBounds(pos) {
    return {
      x: Math.round(Math.min(Math.max(pos.x, EDIT_BOUNDS.minX), EDIT_BOUNDS.maxX) / 5) * 5,
      y: Math.round(Math.min(Math.max(pos.y, EDIT_BOUNDS.minY), EDIT_BOUNDS.maxY) / 5) * 5,
    };
  }

  /** 클릭 지점의 구성요소 인덱스 (겹치면 나중에 놓은 것 우선) */
  function hitTest(pos) {
    for (let i = editor.comps.length - 1; i >= 0; i--) {
      const comp = editor.comps[i];
      let radius = 16;
      for (const s of comp.shapes) {
        const off = Math.hypot(s.x, s.y);
        radius = Math.max(radius, off + (s.kind === 'circle' ? s.r : Math.max(s.w, s.h) / 2));
      }
      if (Math.hypot(pos.x - comp.x, pos.y - comp.y) <= radius) return i;
    }
    return -1;
  }

  eCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const pos = eventToWorld(e);
    const hit = hitTest(pos);
    if (hit >= 0) {
      editor.selected = hit;
      editor.dragging = true;
    } else {
      // 새 구성요소 배치
      const def = COMPONENTS[editor.tool];
      const comp = {
        type: def.id,
        ...clampToBounds(pos),
        props: defaultProps(def),
      };
      rebuildComp(comp);
      editor.comps.push(comp);
      editor.selected = editor.comps.length - 1;
      editor.dragging = true;
    }
    renderPropsPanel();
    eCanvas.setPointerCapture(e.pointerId);
  });

  eCanvas.addEventListener('pointermove', (e) => {
    if (!editor.dragging || editor.selected < 0) return;
    const comp = editor.comps[editor.selected];
    Object.assign(comp, clampToBounds(eventToWorld(e)));
  });

  eCanvas.addEventListener('pointerup', () => {
    editor.dragging = false;
  });

  // 휠 스크롤로 긴 맵 이동
  eCanvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      editor.camY = clampCam(editor.camY + e.deltaY);
    },
    { passive: false }
  );

  // 에디터 미니맵: 클릭/드래그로 화면 이동
  function minimapJump(e) {
    const rect = eMinimap.getBoundingClientRect();
    const worldY = ((e.clientY - rect.top) / rect.height) * WORLD.height;
    editor.camY = clampCam(worldY - VIEW.height / 2);
  }
  eMinimap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    minimapJump(e);
    eMinimap.setPointerCapture(e.pointerId);
    const move = (ev) => minimapJump(ev);
    const up = () => {
      eMinimap.removeEventListener('pointermove', move);
      eMinimap.removeEventListener('pointerup', up);
    };
    eMinimap.addEventListener('pointermove', move);
    eMinimap.addEventListener('pointerup', up);
  });

  function deleteSelected() {
    if (editor.selected < 0) return;
    editor.comps.splice(editor.selected, 1);
    editor.selected = -1;
    renderPropsPanel();
  }

  $('btn-comp-delete').addEventListener('click', deleteSelected);
  document.addEventListener('keydown', (e) => {
    if (!editor.active) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    if (e.key === 'Escape') {
      editor.selected = -1;
      renderPropsPanel();
    }
    if (e.key === 'ArrowDown') editor.camY = clampCam(editor.camY + 80);
    if (e.key === 'ArrowUp') editor.camY = clampCam(editor.camY - 80);
  });

  $('btn-map-save').addEventListener('click', () => {
    const name = $('input-map-name').value.trim();
    const msg = $('editor-msg');
    if (!name) return (msg.textContent = '맵 이름을 입력해주세요.');
    if (editor.comps.length === 0)
      return (msg.textContent = '구성요소를 1개 이상 배치해주세요.');

    const components = editor.comps.map(({ type, x, y, props }) => ({ type, x, y, props }));
    socket.emit('maps:save', { name, components }, (res) => {
      if (!res.ok) return (msg.textContent = res.error || '저장 실패');
      // 방장이면 방금 만든 맵을 바로 선택
      if (room && room.hostId === myId) socket.emit('room:setMap', { mapId: res.id });
      if (room) {
        renderLobby();
        showScreen('lobby');
      } else {
        showScreen('home');
      }
    });
  });

  function renderEditor() {
    if (!editor.active) return;
    const camY = editor.camY;
    eCtx.setTransform(eScale, 0, 0, eScale, 0, 0);
    eCtx.clearRect(0, 0, VIEW.width, VIEW.height);
    eCtx.save();
    eCtx.translate(0, -camY);

    // 배치 불가 구역 표시
    eCtx.fillStyle = 'rgba(77,201,255,0.07)';
    eCtx.fillRect(0, 0, WORLD.width, EDIT_BOUNDS.minY - 20);
    eCtx.fillStyle = 'rgba(93,222,120,0.07)';
    eCtx.fillRect(0, EDIT_BOUNDS.maxY + 20, WORLD.width, WORLD.height - EDIT_BOUNDS.maxY - 20);
    eCtx.font = '13px sans-serif';
    eCtx.textAlign = 'center';
    eCtx.fillStyle = 'rgba(77,201,255,0.6)';
    eCtx.fillText('⬇ 공 시작 구역', WORLD.width / 2, 60);
    eCtx.fillStyle = 'rgba(93,222,120,0.6)';
    eCtx.fillText('GOAL', WORLD.width / 2, WORLD.height - 40);

    // 구성요소 (회전체는 미리보기로 실제 속도로 회전)
    const t = performance.now() / 1000;
    editor.comps.forEach((comp, i) => {
      if (comp.y < camY - 300 || comp.y > camY + VIEW.height + 300) return;
      drawComponent(eCtx, comp, comp.spin ? comp.spin * t : 0);
      if (i === editor.selected) {
        eCtx.strokeStyle = '#5dde78';
        eCtx.lineWidth = 2;
        eCtx.setLineDash([6, 4]);
        let radius = 16;
        for (const s of comp.shapes) {
          const off = Math.hypot(s.x, s.y);
          radius = Math.max(radius, off + (s.kind === 'circle' ? s.r : Math.max(s.w, s.h) / 2));
        }
        eCtx.beginPath();
        eCtx.arc(comp.x, comp.y, radius + 6, 0, Math.PI * 2);
        eCtx.stroke();
        eCtx.setLineDash([]);
      }
    });

    eCtx.restore();

    // 에디터 미니맵
    drawMinimap(eMinimap, {
      components: editor.comps,
      camY,
      elapsed: t,
      selected: editor.selected >= 0 ? editor.comps[editor.selected] : null,
    });

    requestAnimationFrame(renderEditor);
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }
})();
