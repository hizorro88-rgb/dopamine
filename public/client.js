/* global io */
(() => {
  const socket = io();

  // ── 상태 ──────────────────────────────────────────────
  let myId = null;
  let room = null; // room:update 페이로드
  let game = null; // { board, players(Map), items, snapshots[], finishedRanks }
  const $ = (id) => document.getElementById(id);

  socket.on('connect', () => {
    myId = socket.id;
  });

  // ── 화면 전환 ─────────────────────────────────────────
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(`screen-${name}`).classList.add('active');
  }

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
  socket.on('room:update', (data) => {
    room = data;
    if (room.state === 'lobby' && !game) {
      renderLobby();
      showScreen('lobby');
    }
    if (room.state === 'lobby' && game && game.overShown) {
      // 게임 종료 후 대기실 복귀 대기 상태 — 결과 모달의 버튼으로 이동
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
  }

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

  // ── 캔버스 렌더링 ─────────────────────────────────────
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  let scale = 1;

  function setupCanvas() {
    const { world } = game.board;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = world.width * dpr;
    canvas.height = world.height * dpr;
    scale = dpr;
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

  function renderFrame() {
    if (!game) return;
    const { board } = game;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, board.world.width, board.world.height);

    // 골인 지점
    const goal = board.goal;
    const grad = ctx.createLinearGradient(0, goal.y - 60, 0, goal.y + 20);
    grad.addColorStop(0, 'rgba(93,222,120,0)');
    grad.addColorStop(1, 'rgba(93,222,120,0.35)');
    ctx.fillStyle = grad;
    ctx.fillRect(goal.x - goal.width / 2, goal.y - 60, goal.width, 75);
    ctx.fillStyle = '#5dde78';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('GOAL', goal.x, goal.y + 8);

    // 벽
    ctx.fillStyle = '#3a3a5c';
    for (const w of board.walls) {
      ctx.save();
      ctx.translate(w.x, w.y);
      ctx.rotate(w.angle);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-w.w / 2, -w.h / 2, w.w, w.h, 6);
      else ctx.rect(-w.w / 2, -w.h / 2, w.w, w.h);
      ctx.fill();
      ctx.restore();
    }

    // 핀
    for (const peg of board.pegs) {
      ctx.beginPath();
      ctx.arc(peg.x, peg.y, peg.r, 0, Math.PI * 2);
      ctx.fillStyle = '#565685';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(peg.x - 2, peg.y - 2, peg.r * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = '#7d7db5';
      ctx.fill();
    }

    // 공
    const r = board.ballRadius;
    for (const b of interpolatedBalls()) {
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

    // 카운트다운
    const cd = game.countdown;
    $('countdown').textContent =
      cd > 0 ? String(Math.ceil(cd / 1000)) : game.snapshots.length ? '' : '준비...';

    requestAnimationFrame(renderFrame);
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }
})();
