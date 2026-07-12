/* global io, PinballComponents */
(() => {
  const socket = io();
  const { WORLD, COMPONENTS, defaultProps, buildShapes } = PinballComponents;

  // 화면에 보이는 뷰포트 크기 (월드는 세로로 훨씬 길다 → 카메라가 따라감)
  const VIEW = { width: 600, height: 900 };
  // 배치 가능 영역 (maxY 는 맵 길이에 따라 달라짐)
  const EDIT_BOUNDS = { minX: 25, maxX: 575, minY: 130 };

  // ── 상태 ──────────────────────────────────────────────
  let myId = null;
  let room = null; // room:update 페이로드
  let game = null; // { board, players(Map), items, snapshots[], ... }
  let eventRoom = null; // event:update 페이로드
  let myParticipantId = null; // 이벤트 추첨에서 내 공 번호
  let autoJoinedEvent = false;
  const $ = (id) => document.getElementById(id);

  const urlEventCode = new URLSearchParams(location.search).get('event');

  socket.on('connect', () => {
    myId = socket.id;
    // 이벤트 초대 링크(?event=CODE)로 들어온 경우 자동 입장
    if (urlEventCode && !autoJoinedEvent) {
      autoJoinedEvent = true;
      joinEvent(urlEventCode.toUpperCase());
    }
  });

  // ── 후원 링크 (서버 환경변수 DONATION_URL 설정 시에만 표시) ──
  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => {
      if (!cfg.donationUrl) return;
      document.querySelectorAll('.donate-link').forEach((a) => {
        a.href = cfg.donationUrl;
        a.textContent = cfg.donationLabel;
        a.classList.remove('hidden');
      });
      document.querySelectorAll('.donate-hint').forEach((el) => el.classList.remove('hidden'));
    })
    .catch(() => {});

  // ── 화면 전환 ─────────────────────────────────────────
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(`screen-${name}`).classList.add('active');
    editor.active = name === 'editor';
    if (editor.active) requestAnimationFrame(renderEditor);
  }

  // ── 공용: 구성요소 도형 렌더러 ─────────────────────────
  // 서버가 내려준 shapes 를 그대로 그린다. 새 구성요소가 추가돼도 수정 불필요.
  // flat=true(미니맵)면 광택 오버레이 생략.
  function drawComponent(ctx, comp, angle, flat) {
    ctx.save();
    ctx.translate(comp.x, comp.y);
    if (angle) ctx.rotate(angle);
    for (const s of comp.shapes) {
      ctx.fillStyle = s.fill || '#7b7f8c';
      if (s.kind === 'circle') {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
        if (!flat && s.r >= 5) {
          // 무광 금속: 절제된 상단광 → 하단 음영 + 얇은 윤곽
          const g = ctx.createRadialGradient(
            s.x - s.r * 0.3, s.y - s.r * 0.35, s.r * 0.15,
            s.x, s.y, s.r
          );
          g.addColorStop(0, 'rgba(255,255,255,0.22)');
          g.addColorStop(0.45, 'rgba(255,255,255,0.03)');
          g.addColorStop(0.85, 'rgba(0,0,0,0.22)');
          g.addColorStop(1, 'rgba(0,0,0,0.5)');
          ctx.fillStyle = g;
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.4)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      } else {
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(s.angle || 0);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-s.w / 2, -s.h / 2, s.w, s.h, 5);
        else ctx.rect(-s.w / 2, -s.h / 2, s.w, s.h);
        ctx.fill();
        if (!flat) {
          // 브러시드 메탈 느낌의 상하 음영 (절제)
          const g = ctx.createLinearGradient(0, -s.h / 2, 0, s.h / 2);
          g.addColorStop(0, 'rgba(255,255,255,0.12)');
          g.addColorStop(0.5, 'rgba(255,255,255,0.01)');
          g.addColorStop(1, 'rgba(0,0,0,0.32)');
          ctx.fillStyle = g;
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    ctx.restore();
  }

  function drawGoal(ctx, goal) {
    // 체커 피니시 라인 — 레이싱의 격식
    const left = goal.x - goal.width / 2;
    const cols = 20;
    const sq = goal.width / cols;
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < cols; i++) {
        ctx.fillStyle =
          (i + r) % 2 === 0 ? 'rgba(212,175,55,0.28)' : 'rgba(12,12,16,0.65)';
        ctx.fillRect(left + i * sq, goal.y + 2 + r * sq, sq + 0.5, sq);
      }
    }
    // 골드 헤어라인 (골인선)
    ctx.strokeStyle = 'rgba(212,175,55,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(left, goal.y);
    ctx.lineTo(left + goal.width, goal.y);
    ctx.stroke();
    // 은은한 접근 글로우
    const grad = ctx.createLinearGradient(0, goal.y - 60, 0, goal.y);
    grad.addColorStop(0, 'rgba(212,175,55,0)');
    grad.addColorStop(1, 'rgba(212,175,55,0.10)');
    ctx.fillStyle = grad;
    ctx.fillRect(left, goal.y - 60, goal.width, 60);
    ctx.fillStyle = 'rgba(217,192,122,0.85)';
    ctx.font = "600 13px 'Noto Serif KR', serif";
    ctx.textAlign = 'center';
    ctx.fillText('F I N I S H', goal.x, goal.y - 10);
  }

  /** 보드 장식: 좌우 골드 헤어라인 + 깊이 눈금 (계측기 느낌) */
  function drawBoardDecor(ctx, board) {
    const H = board.world.height;
    ctx.strokeStyle = 'rgba(212,175,55,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(1.5, 0);
    ctx.lineTo(1.5, H);
    ctx.moveTo(WORLD.width - 1.5, 0);
    ctx.lineTo(WORLD.width - 1.5, H);
    ctx.stroke();
    ctx.fillStyle = 'rgba(212,175,55,0.20)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    for (let y = 300; y < H - 120; y += 300) {
      ctx.fillRect(WORLD.width - 14, y, 12, 1);
      ctx.fillText(String(y), WORLD.width - 17, y + 3);
    }
  }

  /**
   * 미니맵 렌더러 (게임/에디터 공용)
   * 전체 월드를 축소해 구성요소·공·현재 화면 영역을 표시한다.
   */
  function drawMinimap(
    mCanvas,
    { height, components, balls, camY, elapsed, selected, hidden, explosions }
  ) {
    const mctx = mCanvas.getContext('2d');
    const s = mCanvas.width / WORLD.width;
    mctx.setTransform(s, 0, 0, s, 0, 0);
    mctx.clearRect(0, 0, WORLD.width, height);

    // 골인 지점
    mctx.fillStyle = 'rgba(212,175,55,0.32)';
    mctx.fillRect(0, height - 70, WORLD.width, 70);

    // 구성요소 (회전체는 실제 각도로, 터진 폭탄은 숨김)
    for (let i = 0; i < components.length; i++) {
      if (hidden && hidden.has(i)) continue;
      const comp = components[i];
      drawComponent(mctx, comp, comp.spin ? comp.spin * elapsed : 0, true);
    }

    // 폭발 표시
    if (explosions) {
      const nowMs = performance.now();
      for (const ex of explosions) {
        const t = (nowMs - ex.start) / 600;
        if (t >= 1) continue;
        mctx.globalAlpha = 1 - t;
        mctx.fillStyle = '#ffb03a';
        mctx.beginPath();
        mctx.arc(ex.x, ex.y, ex.radius * 0.6, 0, Math.PI * 2);
        mctx.fill();
        mctx.globalAlpha = 1;
      }
    }

    // 선택된 구성요소 강조 (에디터)
    if (selected) {
      mctx.strokeStyle = '#d4af37';
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

  /** 미니맵 캔버스 해상도 + 화면 크기를 맵 길이 비율에 맞춤 */
  function setupMinimapCanvas(mCanvas, mapH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = 90; // CSS 픽셀 기준 내부 해상도
    mCanvas.width = w * dpr;
    mCanvas.height = w * (mapH / WORLD.width) * dpr;

    // 표시 크기: 세로는 보드의 절반 정도, 짧은 맵은 가로가 너무 커지지 않게 제한
    const wrap = mCanvas.parentElement;
    const wrapH = wrap.clientHeight || 780;
    const wrapW = wrap.clientWidth || 520;
    let h = wrapH * 0.5;
    let cssW = h * (WORLD.width / mapH);
    const maxW = wrapW * 0.2;
    if (cssW > maxW) {
      cssW = maxW;
      h = cssW * (mapH / WORLD.width);
    }
    mCanvas.style.width = cssW + 'px';
    mCanvas.style.height = h + 'px';
  }

  const clampCam = (y, mapH) => Math.min(Math.max(y, 0), Math.max(mapH - VIEW.height, 0));

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

  // ── 후원자 코드 ──
  const inputDonorCode = $('input-donor-code');
  inputDonorCode.value = localStorage.getItem('pinball-donor-code') || '';

  function myDonorCode() {
    return inputDonorCode.value.trim().toUpperCase();
  }

  $('btn-donor-toggle').addEventListener('click', () => {
    $('donor-box').classList.toggle('hidden');
    if (!$('donor-box').classList.contains('hidden')) checkDonorCode();
  });

  function checkDonorCode() {
    const code = myDonorCode();
    const status = $('donor-status');
    if (!code) {
      status.textContent = '후원 후 받은 코드를 입력하면 이름에 💖 배지가 표시됩니다!';
      status.classList.remove('ok');
      return;
    }
    socket.emit('donor:check', { code }, (res) => {
      if (res.ok) {
        localStorage.setItem('pinball-donor-code', code);
        status.textContent = `💖 ${res.name}님, 후원 감사합니다! 혜택이 적용됩니다.`;
        status.classList.add('ok');
      } else {
        status.textContent = '유효하지 않은 코드입니다.';
        status.classList.remove('ok');
      }
    });
  }
  inputDonorCode.addEventListener('change', checkDonorCode);
  // 저장된 코드가 있으면 입력창을 미리 열어 확인 표시
  if (inputDonorCode.value) {
    $('donor-box').classList.remove('hidden');
    socket.on('connect', checkDonorCode);
  }

  // ── 전체 순위 (누적 전적 리더보드) ──
  function openLeaderboard() {
    fetch('/api/leaderboard')
      .then((r) => r.json())
      .then(({ leaderboard }) => {
        const list = $('board-list');
        list.innerHTML = '';
        if (!leaderboard.length) {
          list.innerHTML =
            '<li class="board-empty">아직 기록이 없어요. 첫 게임을 시작해보세요! (2인 이상 게임만 집계)</li>';
        }
        const rankEmoji = ['🥇', '🥈', '🥉'];
        for (const e of leaderboard) {
          const li = document.createElement('li');
          li.innerHTML = `<span class="hall-rank">${rankEmoji[e.rank - 1] || e.rank}</span>
            <span>${escapeHtml(e.name)}</span>
            <span class="board-stats">
              <span class="board-points">${e.points}점</span><br>
              ${e.wins}승 / ${e.plays}판
            </span>`;
          list.appendChild(li);
        }
        $('board-modal').classList.remove('hidden');
      })
      .catch(() => {});
  }
  $('btn-board').addEventListener('click', openLeaderboard);
  $('btn-board-result').addEventListener('click', openLeaderboard);
  $('btn-board-close').addEventListener('click', () => $('board-modal').classList.add('hidden'));

  // ── 명예의 전당 ──
  $('btn-hall').addEventListener('click', () => {
    fetch('/api/donors')
      .then((r) => r.json())
      .then(({ donors }) => {
        const list = $('hall-list');
        list.innerHTML = '';
        if (!donors.length) {
          list.innerHTML = '<li class="hall-empty">아직 후원자가 없어요. 첫 번째 후원자가 되어주세요!</li>';
        }
        const rankEmoji = ['👑', '🥈', '🥉'];
        donors.forEach((d, i) => {
          const li = document.createElement('li');
          li.innerHTML = `<span class="hall-rank">${rankEmoji[i] || i + 1}</span>
            <span>💖 ${escapeHtml(d.name)}</span>
            <span class="hall-amount">${d.amount > 0 ? d.amount.toLocaleString() + '원' : ''}</span>`;
          list.appendChild(li);
        });
        $('hall-modal').classList.remove('hidden');
      })
      .catch(() => {});
  });
  $('btn-hall-close').addEventListener('click', () => $('hall-modal').classList.add('hidden'));

  // ── 우승 조건 선택 (방 만들기) ──
  let homeWinMode = localStorage.getItem('pinball-winmode') || 'first';
  function renderHomeWinMode() {
    $('home-wm-first').classList.toggle('selected', homeWinMode === 'first');
    $('home-wm-last').classList.toggle('selected', homeWinMode === 'last');
  }
  renderHomeWinMode();
  for (const id of ['home-wm-first', 'home-wm-last']) {
    $(id).addEventListener('click', (e) => {
      homeWinMode = e.currentTarget.dataset.mode;
      localStorage.setItem('pinball-winmode', homeWinMode);
      renderHomeWinMode();
    });
  }

  // 인당 공 개수 (방 만들기)
  const homeBallCount = $('home-ball-count');
  homeBallCount.value = localStorage.getItem('pinball-balls') || '1';
  homeBallCount.addEventListener('change', () =>
    localStorage.setItem('pinball-balls', homeBallCount.value)
  );

  $('btn-create').addEventListener('click', () => {
    socket.emit(
      'room:create',
      {
        name: myName(),
        donorCode: myDonorCode(),
        winMode: homeWinMode,
        ballsPerPlayer: Number(homeBallCount.value),
      },
      (res) => {
        if (!res.ok) homeError.textContent = res.error || '방 생성 실패';
      }
    );
  });

  $('btn-join').addEventListener('click', joinRoom);
  inputCode.addEventListener('keydown', (e) => e.key === 'Enter' && joinRoom());

  function joinRoom() {
    const code = inputCode.value.trim().toUpperCase();
    if (!code) return (homeError.textContent = '초대 코드를 입력해주세요.');
    socket.emit('room:join', { code, name: myName(), donorCode: myDonorCode() }, (res) => {
      if (!res.ok) homeError.textContent = res.error || '입장 실패';
    });
  }

  // ── 🎪 이벤트 추첨 ────────────────────────────────────
  $('btn-event-create').addEventListener('click', () => {
    socket.emit('event:create', {}, (res) => {
      if (!res.ok) return (homeError.textContent = res.error || '이벤트 생성 실패');
      eventRoom = { code: res.code };
      $('input-event-name').value = localStorage.getItem('pinball-name') || '';
      showScreen('event');
    });
  });

  function joinEvent(code) {
    socket.emit('event:join', { code }, (res) => {
      if (!res.ok) return (homeError.textContent = res.error || '이벤트 입장 실패');
      eventRoom = res;
      myParticipantId = null;
      $('input-event-name').value = localStorage.getItem('pinball-name') || '';
      $('event-my-status').textContent = '';
      renderEventScreen(res);
      showScreen('event');
      if (res.replay) beginReplay(res.replay); // 재생 중 늦게 합류 → 따라잡기
    });
  }

  socket.on('event:update', (ev) => {
    eventRoom = { ...eventRoom, ...ev };
    renderEventScreen(eventRoom);
  });

  function renderEventScreen(ev) {
    if (!ev || !ev.code) return;
    $('event-code').textContent = ev.code;
    $('event-participant-count').textContent = `참가 ${ev.participantCount || 0}/${ev.maxParticipants || 500}명`;
    $('event-viewers').textContent = `시청 ${ev.viewers || 0}명`;

    const names = $('event-names');
    names.innerHTML = '';
    for (const n of ev.recent || []) {
      const chip = document.createElement('span');
      chip.className = 'name-chip';
      chip.textContent = n;
      names.appendChild(chip);
    }

    const isHost = ev.hostId === myId;
    const startBtn = $('btn-event-start');
    if (ev.state === 'lobby') {
      $('event-register-row').style.display = myParticipantId == null ? '' : 'none';
      startBtn.disabled = !isHost || (ev.participantCount || 0) < 2;
      startBtn.textContent = isHost
        ? '🎲 추첨 시작'
        : '⏳ 호스트가 추첨을 시작하기를 기다리는 중';
      $('event-progress').classList.add('hidden');
    } else if (ev.state === 'simulating') {
      $('event-register-row').style.display = 'none';
      startBtn.disabled = true;
      startBtn.textContent = '🎬 녹화 중...';
      $('event-progress').classList.remove('hidden');
    } else {
      // playing: 재생 중이거나 종료
      $('event-register-row').style.display = 'none';
      startBtn.disabled = !isHost;
      startBtn.textContent = isHost ? '🔄 새 추첨 준비' : '재생 중';
    }

    // 맵 선택 (호스트 전용)
    socket.emit('maps:list', null, (res) => {
      if (!res || !res.ok || !eventRoom) return;
      const select = $('event-map-select');
      select.innerHTML = '';
      for (const m of res.maps) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${mapOptionLabel(m)} · 길이 ${m.height}`;
        select.appendChild(opt);
      }
      select.value = ev.map ? ev.map.id : 'classic';
      select.disabled = ev.hostId !== myId || ev.state !== 'lobby';
    });
  }

  $('event-map-select').addEventListener('change', (e) => {
    socket.emit('event:setMap', { mapId: e.target.value });
  });

  $('btn-event-register').addEventListener('click', () => {
    const name = $('input-event-name').value.trim();
    if (!name) return ($('event-error').textContent = '이름을 입력해주세요.');
    socket.emit('event:register', { name }, (res) => {
      if (!res.ok) return ($('event-error').textContent = res.error || '참가 실패');
      $('event-error').textContent = '';
      myParticipantId = res.participantId;
      $('event-my-status').textContent = `✅ "${name}" 참가 완료! (${res.participantId + 1}번 공)`;
      $('event-register-row').style.display = 'none';
    });
  });

  $('btn-event-start').addEventListener('click', () => {
    if (!eventRoom) return;
    if (eventRoom.state === 'playing') {
      socket.emit('event:again'); // 새 추첨 준비 (참가자 유지)
      myParticipantId = myParticipantId; // 참가 등록도 서버에 유지됨
    } else {
      socket.emit('event:start');
    }
  });

  $('btn-event-copy').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?event=${eventRoom.code}`;
    try {
      await navigator.clipboard.writeText(url);
      $('btn-event-copy').textContent = '✅ 복사 완료!';
    } catch {
      prompt('아래 링크를 복사해서 공유해주세요:', url);
    }
    setTimeout(() => ($('btn-event-copy').textContent = '🔗 초대 링크 복사'), 1500);
  });

  socket.on('event:simprogress', ({ pct }) => {
    $('event-progress').classList.remove('hidden');
    $('event-progress-pct').textContent = pct;
  });

  socket.on('event:error', ({ error }) => {
    $('event-error').textContent = error || '오류가 발생했습니다.';
  });

  socket.on('event:ready', (info) => beginReplay(info));

  async function beginReplay({ replayUrl, startAt, serverNow }) {
    try {
      const replay = await (await fetch(replayUrl)).json();
      const offset = serverNow - Date.now(); // 서버 시계 보정
      startReplayPlayback(replay, startAt, offset);
    } catch {
      $('event-error').textContent = '리플레이 다운로드에 실패했습니다. 새로고침 해주세요.';
    }
  }

  function startReplayPlayback(replay, startAt, offset) {
    game = {
      board: replay.board,
      winMode: 'first',
      players: new Map(replay.players.map((p) => [p.id, p])),
      items: [],
      snapshots: [],
      countdown: 0,
      finishedRanks: [],
      overShown: false,
      camY: 0,
      explosions: [],
      hiddenComps: new Set(),
      shakeUntil: 0,
      replay: {
        frames: replay.frames,
        events: replay.events,
        ranking: replay.ranking,
        durationMs: replay.durationMs,
        startAt,
        offset,
        fi: 0,
        ei: 0,
      },
    };
    $('item-bar').style.display = 'none'; // 시청자는 아이템 없음 (자동 발동)
    document.querySelector('#rank-board h3').textContent = `🎪 이벤트 추첨 · 참가 ${replay.players.length}명`;
    $('rank-list').innerHTML = '';
    $('toast-area').innerHTML = '';
    $('result-modal').classList.add('hidden');
    $('target-modal').classList.add('hidden');
    showScreen('game');
    setupCanvas();
    requestAnimationFrame(renderFrame);
  }

  function dispatchReplayEvent(ev) {
    if (ev.type === 'finish') {
      appendFinishRow(ev);
      if (ev.rank === 1) toast(`🎉 1등 당첨: ${ev.name}!`);
    } else if (ev.type === 'item') {
      toast(
        ev.self
          ? `${ev.item.emoji} ${ev.by} → ${ev.item.name} 발동!`
          : `${ev.item.emoji} ${ev.by} → ${ev.target}에게 ${ev.item.name}!`
      );
    } else if (ev.type === 'explosion') {
      game.explosions.push({ x: ev.x, y: ev.y, radius: ev.radius, start: performance.now() });
      if (Math.abs(ev.y - (game.camY + VIEW.height / 2)) < VIEW.height) {
        game.shakeUntil = performance.now() + 250;
      }
    }
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
        <span>${p.isDonor ? '💖 ' : ''}${escapeHtml(p.name)}${p.id === myId ? ' (나)' : ''}</span>
        ${p.id === room.hostId ? '<span class="host-badge">👑 방장</span>' : ''}`;
      list.appendChild(li);
    }
    const isHost = room.hostId === myId;
    const startBtn = $('btn-start');
    startBtn.disabled = !isHost;
    startBtn.textContent = isHost ? '🚀 게임 시작' : '⏳ 방장이 시작하기를 기다리는 중';
    $('btn-start-random').disabled = !isHost;
    $('lobby-hint').textContent = `${room.players.length}/${room.maxPlayers}명 · 시작하면 각자 랜덤 아이템 2개를 받아요!`;

    // 우승 조건 표시 (방장만 변경 가능)
    $('lobby-wm-first').classList.toggle('selected', room.winMode !== 'last');
    $('lobby-wm-last').classList.toggle('selected', room.winMode === 'last');
    $('lobby-wm-first').disabled = !isHost;
    $('lobby-wm-last').disabled = !isHost;

    // 인당 공 개수 (방장만 변경 가능)
    $('lobby-ball-count').value = String(room.ballsPerPlayer || 1);
    $('lobby-ball-count').disabled = !isHost;

    refreshMaps();
  }

  $('lobby-ball-count').addEventListener('change', (e) => {
    socket.emit('room:setBalls', { ballsPerPlayer: Number(e.target.value) });
  });

  for (const id of ['lobby-wm-first', 'lobby-wm-last']) {
    $(id).addEventListener('click', (e) => {
      socket.emit('room:setWinMode', { winMode: e.currentTarget.dataset.mode });
    });
  }

  /** 맵 옵션 라벨: 평점이 있으면 ★ 표시 (목록은 서버가 평점순으로 정렬) */
  function mapOptionLabel(m) {
    const stars = m.reviews > 0 ? ` ★${m.rating}` : '';
    return `${m.builtin ? '⭐' : '🛠'} ${m.name}${stars} — ${m.author}`;
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
        opt.textContent = mapOptionLabel(m);
        select.appendChild(opt);
      }
      select.value = room.map ? room.map.id : 'classic';
      select.disabled = room.hostId !== myId;
      updateMapInfo();
    });
  }

  function updateMapInfo() {
    const meta = mapList.find((m) => m.id === $('map-select').value);
    if (!meta) return ($('map-info').textContent = '');
    const rating = meta.reviews > 0 ? `★${meta.rating} (후기 ${meta.reviews}개) · ` : '';
    $('map-info').textContent = `${rating}구성요소 ${meta.count}개 · 길이 ${meta.height} · ${room.hostId === myId ? '맵을 선택하세요' : '방장이 맵을 선택합니다'}`;
  }

  $('map-select').addEventListener('change', (e) => {
    socket.emit('room:setMap', { mapId: e.target.value });
  });

  // ── 맵 후기 (커뮤니티) ────────────────────────────────
  let reviewRating = 5;
  function renderStarPicker() {
    const picker = $('star-picker');
    picker.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement('button');
      b.className = 'star-btn' + (i <= reviewRating ? ' on' : '');
      b.textContent = '★';
      b.title = `${i}점`;
      b.addEventListener('click', () => {
        reviewRating = i;
        renderStarPicker();
      });
      picker.appendChild(b);
    }
  }

  function openReviews(keepForm) {
    const mapId = $('map-select').value;
    const meta = mapList.find((m) => m.id === mapId);
    socket.emit('reviews:list', { mapId }, (res) => {
      if (!res || !res.ok) return;
      $('review-title').textContent = `💬 「${meta ? meta.name : '맵'}」 후기`;
      $('review-summary').textContent =
        res.count > 0
          ? `★ ${res.avg} · 후기 ${res.count}개`
          : '아직 후기가 없어요 — 첫 후기를 남겨주세요!';
      const list = $('review-list');
      list.innerHTML = '';
      if (!res.reviews.length) {
        list.innerHTML =
          '<li class="review-empty">이 맵을 플레이해봤다면 별점과 한 줄 평을 남겨주세요.</li>';
      }
      for (const v of res.reviews) {
        const li = document.createElement('li');
        li.innerHTML = `<div class="review-head">
            <span class="review-stars">${'★'.repeat(v.rating)}${'☆'.repeat(5 - v.rating)}</span>
            <span class="review-name">${escapeHtml(v.name)}</span>
            <span class="review-date">${new Date(v.at).toLocaleDateString()}</span>
          </div>
          ${v.text ? `<div class="review-text">${escapeHtml(v.text)}</div>` : ''}`;
        list.appendChild(li);
      }
      if (!keepForm) {
        reviewRating = 5;
        renderStarPicker();
        $('input-review-text').value = '';
        $('review-msg').textContent = '';
      }
      $('review-modal').classList.remove('hidden');
    });
  }

  $('btn-reviews').addEventListener('click', () => openReviews(false));
  $('btn-review-close').addEventListener('click', () =>
    $('review-modal').classList.add('hidden')
  );

  $('btn-review-submit').addEventListener('click', () => {
    const mapId = $('map-select').value;
    socket.emit(
      'reviews:add',
      { mapId, rating: reviewRating, text: $('input-review-text').value, name: myName() },
      (res) => {
        if (!res.ok) return ($('review-msg').textContent = res.error || '등록 실패');
        $('input-review-text').value = '';
        openReviews(false); // 목록 새로고침
        refreshMaps(); // 드롭다운 별점 반영
      }
    );
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
  $('btn-start-random').addEventListener('click', () => socket.emit('game:startRandom'));

  // ── 게임 시작 ─────────────────────────────────────────
  socket.on('game:started', ({ board, players, yourItems, winMode, ballsPerPlayer, shuffle, autoPilot }) => {
    game = {
      board,
      autoPilot: !!autoPilot,
      winMode: winMode || 'first',
      ballsPer: ballsPerPlayer || 1,
      shuffling: !!shuffle,
      players: new Map(players.map((p) => [p.id, p])),
      items: yourItems, // [{id,name,emoji,desc,target,duration} | null]
      snapshots: [],
      clockOffset: null, // 서버 시계 추정치 (보간용)
      countdown: 0,
      finishedRanks: [],
      overShown: false,
      camY: 0,
      explosions: [], // {x, y, radius, start} — 폭발 애니메이션
      hiddenComps: new Set(), // 터져서 잠시 사라진 구성요소 인덱스
      shakeUntil: 0,
    };
    $('rank-list').innerHTML = '';
    $('toast-area').innerHTML = '';
    // 올랜덤(관전)은 아이템 바 숨김, 시스템이 정한 조건을 알림
    $('item-bar').style.display = game.autoPilot ? 'none' : '';
    if (game.autoPilot) {
      toast(
        `🎲 올랜덤 — 맵: ${board.mapName} · 인당 공 ${game.ballsPer}개 · ${game.winMode === 'last' ? '🐢 늦게' : '🥇 먼저'} 골인 우승`
      );
    }
    // 순위판 제목에 우승 조건 표시
    document.querySelector('#rank-board h3').textContent =
      (game.autoPilot ? '🎲 올랜덤 · ' : '') +
      (game.winMode === 'last' ? '도착 순서 · 🐢 늦게 골인 우승' : '순위 · 🥇 먼저 골인 우승');
    $('result-modal').classList.add('hidden');
    $('target-modal').classList.add('hidden');
    renderItems();
    showScreen('game'); // 화면 표시 후에 캔버스 크기 계산 (숨김 상태에선 부모 크기가 0)
    setupCanvas();
    requestAnimationFrame(renderFrame);
  });

  socket.on('game:snapshot', (snap) => {
    if (!game || game.replay) return;
    snap.recv = performance.now();
    // 서버 시계 추정: 지연이 가장 적었던 패킷 기준 (지터에 흔들리지 않도록 슬라이딩 최대값)
    const inst = snap.t - snap.recv;
    game.clockOffset = game.clockOffset == null ? inst : Math.max(inst, game.clockOffset - 4);
    game.snapshots.push(snap);
    if (game.snapshots.length > 12) game.snapshots.shift();
    game.countdown = snap.countdown;
    // 셔플 → 낙하 전환 순간 "GO!" 표시
    if (game.shuffling && !snap.sh) {
      toast('🎲 낙하 시작!');
    }
    game.shuffling = !!snap.sh;
    game.hiddenComps = new Set(snap.off || []);
  });

  $('btn-drop').addEventListener('click', () => {
    socket.emit('game:drop');
    $('btn-drop').classList.add('hidden');
  });

  socket.on('game:explosion', ({ x, y, radius }) => {
    if (!game) return;
    game.explosions.push({ x, y, radius, start: performance.now() });
    // 화면 안에서 터졌으면 카메라 흔들기
    if (Math.abs(y - (game.camY + VIEW.height / 2)) < VIEW.height) {
      game.shakeUntil = performance.now() + 250;
    }
  });

  // 🎡 인생은 돌고돌아 발동: 골인 직전의 공이 원점으로
  socket.on('game:karma', ({ name, x, y }) => {
    if (!game) return;
    toast(`🎡 인생은 돌고돌아! ${name}의 공이 골인 직전에 원점으로...!`);
    game.explosions.push({ x, y, radius: 130, start: performance.now() });
    game.shakeUntil = performance.now() + 350;
  });

  /** 실시간 순위판에 도착 기록 추가 (10명까지, 이후는 카운터) */
  function appendFinishRow({ playerId, name, rank, timeMs, p: participantId }) {
    const key = playerId !== undefined ? playerId : participantId;
    game.finishedRanks.push({ playerId: key, name, rank });
    const list = $('rank-list');
    if (rank <= 10) {
      const p = game.players.get(key);
      const isLast = game.winMode === 'last';
      const mineKey = game.replay ? myParticipantId : myId;
      const li = document.createElement('li');
      // 늦게 골인 모드에서는 도착 순서가 순위와 반대이므로 "n번째 도착"으로 표시
      li.innerHTML = `<span class="rank-num">${rank}${isLast ? '번째' : '등'}</span>
        <span class="player-dot" style="background:${p ? p.color : '#888'}"></span>
        <span>${escapeHtml(name)}${key === mineKey ? ' (나)' : ''}</span>
        <span class="result-time">${formatTime(timeMs)}</span>`;
      list.appendChild(li);
    } else {
      let more = document.getElementById('rank-more');
      if (!more) {
        more = document.createElement('li');
        more.id = 'rank-more';
        list.appendChild(more);
      }
      more.textContent = `... 외 ${rank - 10}명 도착`;
    }
  }

  socket.on('game:ballFinished', (data) => {
    if (!game || game.replay) return;
    appendFinishRow(data);
    if (data.rank === 1) {
      toast(
        game.winMode === 'last'
          ? `⚡ ${data.name}님이 가장 먼저 도착... 늦게 골인이 우승인데요!`
          : `🏆 ${data.name}님이 1등으로 도착!`
      );
    }
  });

  function formatTime(timeMs) {
    return timeMs == null ? '' : (timeMs / 1000).toFixed(1) + '초';
  }

  socket.on('game:itemUsed', ({ by, item, target, self }) => {
    toast(
      self
        ? `${item.emoji} ${by} → ${item.name} 사용!`
        : `${item.emoji} ${by} → ${target}에게 ${item.name}!`
    );
  });

  socket.on('game:over', ({ ranking }) => {
    if (!game || game.replay) return;
    game.overShown = true;
    showResults(ranking, { event: false });
  });

  /** 최종 결과 화면 (아이템전/이벤트 추첨 공용) */
  function showResults(ranking, { event = false } = {}) {
    const mineKey = event ? myParticipantId : myId;

    // 우승자 배너
    const winner = ranking[0];
    $('winner-banner').textContent = winner
      ? event
        ? `🎉 1등 당첨: ${winner.name}${winner.playerId === mineKey ? ' (나!)' : ''}`
        : `🏆 ${winner.name}${winner.playerId === mineKey ? ' (나)' : ''} 우승!`
      : '';

    // 시상대 (1~3등, 표시 순서: 2등-1등-3등)
    const podium = $('podium');
    podium.innerHTML = '';
    const medals = ['🥇', '🥈', '🥉'];
    const classes = ['first', 'second', 'third'];
    const top3 = ranking.slice(0, 3);
    const order = [top3[1], top3[0], top3[2]].filter(Boolean);
    for (const r of order) {
      const col = document.createElement('div');
      col.className = `podium-col ${classes[r.rank - 1]}`;
      col.innerHTML = `
        <span class="podium-medal">${medals[r.rank - 1]}</span>
        <span class="podium-ball" style="background:${r.color};color:${r.color}"></span>
        <span class="podium-name">${escapeHtml(r.name)}${r.playerId === mineKey ? ' ★' : ''}</span>
        <span class="podium-time">${r.finished ? formatTime(r.timeMs) : '미도착'}</span>
        <div class="podium-block">${r.rank}등</div>`;
      podium.appendChild(col);
    }

    // 4등 이하 목록 (최대 50명 표시)
    const list = $('result-list');
    list.innerHTML = '';
    for (const r of ranking.slice(3, 53)) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="rank-num">${r.rank}등</span>
        <span class="player-dot" style="background:${r.color}"></span>
        <span>${escapeHtml(r.name)}${r.playerId === mineKey ? ' (나)' : ''}</span>
        <span class="result-time">${r.finished ? formatTime(r.timeMs) : '미도착'}</span>`;
      list.appendChild(li);
    }
    if (ranking.length > 53) {
      const li = document.createElement('li');
      li.style.justifyContent = 'center';
      li.style.color = 'var(--muted)';
      li.textContent = `... 외 ${ranking.length - 53}명`;
      list.appendChild(li);
    }

    $('btn-back-lobby').textContent = event ? '이벤트로 돌아가기' : '대기실로 돌아가기';
    $('result-modal').classList.remove('hidden');
    startConfetti();
  }

  // ── 색종이 축하 효과 ──────────────────────────────────
  // 금박·은박·크림슨 — 승자의 색
  const CONFETTI_COLORS = ['#d4af37', '#e8d48b', '#b23a48', '#f0ead6', '#c0c0c8', '#8a6d4a'];
  function startConfetti() {
    const c = $('confetti');
    c.width = c.clientWidth;
    c.height = c.clientHeight;
    const cx = c.getContext('2d');
    const parts = Array.from({ length: 110 }, () => ({
      x: Math.random() * c.width,
      y: -Math.random() * c.height * 0.6,
      w: 5 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      vy: 1.6 + Math.random() * 2.6,
      vx: (Math.random() - 0.5) * 1.4,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.18,
    }));
    const step = () => {
      if ($('result-modal').classList.contains('hidden')) {
        cx.clearRect(0, 0, c.width, c.height);
        return; // 화면 닫히면 종료
      }
      cx.clearRect(0, 0, c.width, c.height);
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        if (p.y > c.height + 20) {
          p.y = -20;
          p.x = Math.random() * c.width;
        }
        cx.save();
        cx.translate(p.x, p.y);
        cx.rotate(p.rot);
        cx.fillStyle = p.color;
        cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        cx.restore();
      }
      requestAnimationFrame(step);
    };
    step();
  }

  $('btn-back-lobby').addEventListener('click', () => {
    $('result-modal').classList.add('hidden');
    const wasReplay = game && game.replay;
    game = null;
    if (wasReplay && eventRoom) {
      renderEventScreen(eventRoom);
      showScreen('event');
    } else if (room) {
      renderLobby();
      showScreen('lobby');
    } else {
      showScreen('home');
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
      const gradeClass =
        item && item.grade === 'legend' ? ' legend' : item && item.grade === 'epic' ? ' epic' : '';
      div.className = 'item-slot' + (item ? gradeClass : ' used');
      if (item) {
        div.title =
          (item.grade === 'legend' ? '👑 레전드 · ' : item.grade === 'epic' ? '⭐ 에픽 · ' : '') +
          item.desc;
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
    setupMinimapCanvas(minimap, game.board.world.height);
  }

  // ── 스냅샷 보간 ───────────────────────────────────────
  // 서버 타임스탬프 기준으로 "약간 과거"를 렌더링한다.
  // 패킷 도착 시각의 지터에 흔들리지 않아 어떤 네트워크에서도 부드럽다.
  const INTERP_DELAY_MS = 90; // 스냅샷 간격(33ms)의 ~3배 뒤를 렌더링
  const REPLAY_DELAY_MS = 60; // 리플레이 프레임(50ms 간격)용

  /** 현재 렌더링할 서버 시각 */
  function renderTime() {
    if (game.replay) {
      return Date.now() + game.replay.offset - game.replay.startAt - REPLAY_DELAY_MS;
    }
    if (game.clockOffset == null) return 0;
    return performance.now() + game.clockOffset - INTERP_DELAY_MS;
  }

  /** renderT 시각을 감싸는 두 스냅샷 사이를 보간 */
  function interpolatedBalls(renderT) {
    const snaps = game.snapshots;
    if (snaps.length === 0) return [];
    if (snaps.length === 1) return snaps[0].balls;

    let ai = 0;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].t <= renderT) {
        ai = i;
        break;
      }
    }
    const a = snaps[ai];
    const b = snaps[Math.min(ai + 1, snaps.length - 1)];
    const span = b.t - a.t;
    const alpha = span > 0 ? Math.min(Math.max((renderT - a.t) / span, 0), 1) : 1;

    // 공 매칭 키: 멀티볼은 k(playerId:idx), 리플레이는 p
    const keyOf = (x) => x.k || x.p;
    return b.balls.map((bb) => {
      const ab = a.balls.find((x) => keyOf(x) === keyOf(bb));
      if (!ab) return bb;
      return {
        ...bb,
        x: ab.x + (bb.x - ab.x) * alpha,
        y: ab.y + (bb.y - ab.y) * alpha,
        px: ab.x, // 모션 트레일용 직전 위치
        py: ab.y,
      };
    });
  }

  /** 회전 구성요소의 현재 각도 계산용 경과 시간(초) — 렌더 시각과 동기 */
  function gameElapsedSec(renderT) {
    const snaps = game.snapshots;
    if (snaps.length === 0) return 0;
    const last = snaps[snaps.length - 1];
    // 게임 시작 시각(서버) = t - elapsed 는 상수 → renderT 기준 경과시간
    return Math.max(0, (renderT - (last.t - last.elapsed)) / 1000);
  }

  function renderFrame() {
    if (!game) return;

    // ── 이벤트 리플레이: 재생 시각에 맞춰 프레임/이벤트 공급 ──
    if (game.replay) {
      const rp = game.replay;
      const playT = Date.now() + rp.offset - rp.startAt;
      if (playT < 0) {
        $('countdown').textContent = `추첨 시작 ${Math.ceil(-playT / 1000)}초 전`;
      } else {
        $('countdown').textContent = '';
        while (rp.fi < rp.frames.length && rp.frames[rp.fi].t <= playT) {
          const f = rp.frames[rp.fi++];
          game.snapshots.push({
            t: f.t, // 리플레이 시간축 (renderTime과 동일 기준)
            elapsed: f.t,
            countdown: 0,
            balls: f.b.map(([p, x, y, fl]) => ({
              p,
              x,
              y,
              g: fl & 1 ? 1 : 0,
              f: fl & 2 ? 1 : 0,
              b: fl & 4 ? 1 : 0,
            })),
          });
          if (game.snapshots.length > 12) game.snapshots.shift();
          game.hiddenComps = new Set(f.off || []);
        }
        while (rp.ei < rp.events.length && rp.events[rp.ei].t <= playT) {
          dispatchReplayEvent(rp.events[rp.ei++]);
        }
        if (playT > rp.durationMs + 1500 && !game.overShown) {
          game.overShown = true;
          showResults(rp.ranking, { event: true });
        }
      }
    }

    const { board } = game;
    const renderT = renderTime();
    const balls = interpolatedBalls(renderT);
    const elapsed = gameElapsedSec(renderT);

    // 카메라: 내 선두 공을 따라감. 내 공이 다 도착하면 선두(가장 아래) 공을 따라감.
    // 리플레이(이벤트 추첨)에서는 항상 선두 공을 따라감.
    const mapH = board.world.height;
    const mine = game.replay
      ? null
      : balls.filter((b) => b.p === myId).reduce((a, b) => (!a || b.y > a.y ? b : a), null);
    const focus = mine || balls.reduce((a, b) => (!a || b.y > a.y ? b : a), null);
    if (focus) {
      const target = clampCam(focus.y - VIEW.height * 0.42, mapH);
      game.camY += (target - game.camY) * 0.08;
    }
    const camY = game.camY;

    // 폭발 시 카메라 흔들림
    let shakeX = 0;
    let shakeY = 0;
    if (game.shakeUntil > performance.now()) {
      const m = (5 * (game.shakeUntil - performance.now())) / 250;
      shakeX = (Math.random() - 0.5) * m * 2;
      shakeY = (Math.random() - 0.5) * m * 2;
    }

    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, VIEW.width, VIEW.height);
    ctx.save();
    ctx.translate(shakeX, -camY + shakeY);

    drawBoardDecor(ctx, board);
    drawGoal(ctx, board.goal);

    // 맵 구성요소 (화면 근처만 그리기, 회전체는 경과 시간으로 각도 계산 → 서버와 동기화)
    for (let i = 0; i < board.components.length; i++) {
      const comp = board.components[i];
      if (game.hiddenComps.has(i)) continue; // 터진 폭탄 등은 재생성까지 숨김
      if (comp.y < camY - 300 || comp.y > camY + VIEW.height + 300) continue;
      drawComponent(ctx, comp, comp.spin ? comp.spin * elapsed : 0);
    }

    // 공 (인원이 많으면 그림자/이름표 생략 — 선두와 내 공만 이름표)
    const r = board.ballRadius;
    const many = game.players.size > 30;
    const mineKey = game.replay ? myParticipantId : myId;
    const focusKey = focus ? focus.p : null;
    for (const b of balls) {
      const p = game.players.get(b.p);
      const color = p ? p.color : '#888';
      const radius = b.b ? r * 1.6 : r;

      ctx.save();
      if (b.g) ctx.globalAlpha = 0.45; // 유령 상태

      // 모션 트레일 (속도가 빠를수록 길게)
      if (b.px !== undefined && !game.shuffling) {
        const dx = b.x - b.px;
        const dy = b.y - b.py;
        const speed = Math.hypot(dx, dy);
        if (speed > 2) {
          const len = Math.min(speed * 2.2, radius * 4);
          ctx.strokeStyle = color;
          ctx.globalAlpha = (b.g ? 0.45 : 1) * 0.22;
          ctx.lineWidth = radius * 1.5;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(b.x - (dx / speed) * len, b.y - (dy / speed) * len);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.globalAlpha = b.g ? 0.45 : 1;
        }
      }

      // 본체 — 연마된 금속구: 절제된 음영 + 작고 날카로운 스펙큘러
      ctx.beginPath();
      ctx.arc(b.x, b.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      const sheen = ctx.createRadialGradient(
        b.x - radius * 0.28, b.y - radius * 0.32, radius * 0.2,
        b.x, b.y, radius
      );
      sheen.addColorStop(0, 'rgba(255,255,255,0.30)');
      sheen.addColorStop(0.4, 'rgba(255,255,255,0.04)');
      sheen.addColorStop(0.78, 'rgba(0,0,0,0.16)');
      sheen.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = sheen;
      ctx.fill();
      // 날카로운 스펙큘러 점
      ctx.beginPath();
      ctx.arc(b.x - radius * 0.32, b.y - radius * 0.38, radius * 0.16, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fill();
      // 윤곽으로 형태를 조임
      ctx.beginPath();
      ctx.arc(b.x, b.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // 내 공은 금테로 표시
      if (b.p === mineKey) {
        ctx.strokeStyle = 'rgba(212,175,55,0.85)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();

      // 상태 이모지
      if (b.f || b.g) {
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        if (b.f) ctx.fillText('🧊', b.x, b.y + 5);
        if (b.g) ctx.fillText('👻', b.x, b.y + 5);
      }

      // 이름표 (후원자는 💖, 멀티볼은 번호 표기)
      const showLabel = !many || b.p === mineKey || b.p === focusKey;
      if (showLabel) {
        const idxTag = game.ballsPer > 1 && b.i !== undefined ? `·${b.i + 1}` : '';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.textAlign = 'center';
        ctx.fillText(
          (p && p.isDonor ? '💖' : '') +
            (p ? p.name : '?') +
            idxTag +
            (b.p === mineKey ? ' ★' : ''),
          b.x,
          b.y - radius - 6
        );
      }
    }

    // 폭발 이펙트 (확장 링 + 화염 + 파편)
    const nowMs = performance.now();
    game.explosions = game.explosions.filter((ex) => nowMs - ex.start < 600);
    for (const ex of game.explosions) {
      const t = (nowMs - ex.start) / 600;
      const ease = 1 - Math.pow(1 - t, 3);
      const r = ex.radius * (0.25 + 0.75 * ease);
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.35;
      ctx.fillStyle = '#ff7a3a';
      ctx.beginPath();
      ctx.arc(ex.x, ex.y, r * 0.65, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = '#ffb03a';
      ctx.lineWidth = 5 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#ffd76a';
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI * 2 * i) / 8 + 0.4;
        ctx.beginPath();
        ctx.arc(ex.x + Math.cos(a) * r, ex.y + Math.sin(a) * r, 3.5 * (1 - t) + 1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.restore();

    // 미니맵
    drawMinimap(minimap, {
      height: mapH,
      components: board.components,
      hidden: game.hiddenComps,
      explosions: game.explosions,
      balls: balls.map((b) => {
        const p = game.players.get(b.p);
        return { x: b.x, y: b.y, color: p ? p.color : '#888', mine: b.p === myId };
      }),
      camY,
      elapsed,
    });

    // 상태 표시 + 방장 낙하 버튼 (리플레이는 위에서 자체 표시)
    if (!game.replay) {
      if (game.shuffling) {
        const isHost = !game.autoPilot && room && room.hostId === myId;
        $('countdown').textContent = game.autoPilot
          ? '🎲 운명이 배치를 정하는 중...'
          : isHost
            ? '🎲 타이밍을 노리세요!'
            : '🎲 위치 섞는 중...';
        $('btn-drop').classList.toggle('hidden', !isHost);
      } else {
        $('countdown').textContent = game.snapshots.length ? '' : '준비...';
        $('btn-drop').classList.add('hidden');
      }
    } else {
      $('btn-drop').classList.add('hidden');
    }

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
    height: WORLD.height, // 이 맵의 길이 (슬라이더로 조절)
  };

  const editMaxY = () => editor.height - 100;

  const eCanvas = $('editor-canvas');
  const eCtx = eCanvas.getContext('2d');
  const eMinimap = $('editor-minimap');
  let eScale = 1;

  function setupEditorCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    eCanvas.width = VIEW.width * dpr;
    eCanvas.height = VIEW.height * dpr;
    eScale = dpr;
    setupMinimapCanvas(eMinimap, editor.height);
  }

  function rebuildComp(comp) {
    const built = buildShapes(comp.type, comp.props);
    comp.shapes = built.shapes;
    comp.spin = built.spin;
    comp.hit = built.hit || null;
  }

  function openEditor() {
    editor.comps = [];
    editor.selected = -1;
    editor.tool = 'peg';
    editor.camY = 0;
    editor.height = WORLD.height;
    $('input-map-length').value = WORLD.height;
    $('map-length-label').textContent = `📐 맵 길이: ${WORLD.height}`;
    $('input-map-name').value = '';
    $('editor-msg').textContent = '';
    renderPalette();
    renderPropsPanel();
    showScreen('editor'); // 화면 표시 후에 캔버스 크기 계산
    setupEditorCanvas();
  }

  // 맵 길이 슬라이더: 줄이면 범위를 벗어난 구성요소를 안쪽으로 이동
  $('input-map-length').addEventListener('input', (e) => {
    editor.height = Number(e.target.value);
    $('map-length-label').textContent = `📐 맵 길이: ${editor.height}`;
    for (const comp of editor.comps) {
      if (comp.y > editMaxY()) comp.y = editMaxY();
    }
    editor.camY = clampCam(editor.camY, editor.height);
    setupMinimapCanvas(eMinimap, editor.height);
  });

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
      y: Math.round(Math.min(Math.max(pos.y, EDIT_BOUNDS.minY), editMaxY()) / 5) * 5,
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
      editor.camY = clampCam(editor.camY + e.deltaY, editor.height);
    },
    { passive: false }
  );

  // 에디터 미니맵: 클릭/드래그로 화면 이동
  function minimapJump(e) {
    const rect = eMinimap.getBoundingClientRect();
    const worldY = ((e.clientY - rect.top) / rect.height) * editor.height;
    editor.camY = clampCam(worldY - VIEW.height / 2, editor.height);
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
    if (e.key === 'ArrowDown') editor.camY = clampCam(editor.camY + 80, editor.height);
    if (e.key === 'ArrowUp') editor.camY = clampCam(editor.camY - 80, editor.height);
  });

  $('btn-map-save').addEventListener('click', () => {
    const name = $('input-map-name').value.trim();
    const msg = $('editor-msg');
    if (!name) return (msg.textContent = '맵 이름을 입력해주세요.');
    if (editor.comps.length === 0)
      return (msg.textContent = '구성요소를 1개 이상 배치해주세요.');

    const components = editor.comps.map(({ type, x, y, props }) => ({ type, x, y, props }));
    socket.emit('maps:save', { name, components, height: editor.height }, (res) => {
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
    const maxY = editMaxY();
    eCtx.fillStyle = 'rgba(212,175,55,0.05)';
    eCtx.fillRect(0, 0, WORLD.width, EDIT_BOUNDS.minY - 20);
    eCtx.fillStyle = 'rgba(212,175,55,0.07)';
    eCtx.fillRect(0, maxY + 20, WORLD.width, editor.height - maxY - 20);
    eCtx.font = '13px sans-serif';
    eCtx.textAlign = 'center';
    eCtx.fillStyle = 'rgba(212,175,55,0.55)';
    eCtx.fillText('⬇ 공 시작 구역', WORLD.width / 2, 60);
    eCtx.fillStyle = 'rgba(227,199,120,0.65)';
    eCtx.fillText('GOAL', WORLD.width / 2, editor.height - 40);

    // 맵 바닥 경계선
    eCtx.strokeStyle = 'rgba(212,175,55,0.4)';
    eCtx.lineWidth = 2;
    eCtx.beginPath();
    eCtx.moveTo(0, editor.height);
    eCtx.lineTo(WORLD.width, editor.height);
    eCtx.stroke();

    // 구성요소 (회전체는 미리보기로 실제 속도로 회전)
    const t = performance.now() / 1000;
    editor.comps.forEach((comp, i) => {
      if (comp.y < camY - 300 || comp.y > camY + VIEW.height + 300) return;
      drawComponent(eCtx, comp, comp.spin ? comp.spin * t : 0);
      if (i === editor.selected) {
        eCtx.strokeStyle = '#d4af37';
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
        // 폭탄 등: 발동 범위 미리보기
        if (comp.hit && comp.hit.radius) {
          eCtx.strokeStyle = 'rgba(255,176,58,0.55)';
          eCtx.beginPath();
          eCtx.arc(comp.x, comp.y, comp.hit.radius, 0, Math.PI * 2);
          eCtx.stroke();
        }
        eCtx.setLineDash([]);
      }
    });

    eCtx.restore();

    // 에디터 미니맵
    drawMinimap(eMinimap, {
      height: editor.height,
      components: editor.comps,
      camY,
      elapsed: t,
      selected: editor.selected >= 0 ? editor.comps[editor.selected] : null,
    });

    requestAnimationFrame(renderEditor);
  }

  // 창 크기 변경 시 미니맵 표시 크기 다시 계산
  window.addEventListener('resize', () => {
    if (game) setupMinimapCanvas(minimap, game.board.world.height);
    if (editor.active) setupMinimapCanvas(eMinimap, editor.height);
  });

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }
})();
