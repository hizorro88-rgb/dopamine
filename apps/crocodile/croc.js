/**
 * 🐊 악어 룰렛 (Crocodile Roulette) — 다같이 하는 턴제 파티게임
 * ───────────────────────────────────────────────────────────
 * 악어(또는 상어)가 입을 벌리고 있고 이빨이 여러 개. 참가자가 순서대로
 * 이빨을 하나씩 누른다. 그중 딱 하나가 "함정 이빨" — 누르는 순간 입을 쾅!
 * 다물어 그 사람이 걸린다.
 *
 * 핵심은 "애니메이션과 긴장(도파민)". 안전한 이빨을 눌러도 서버가 무작위로
 * '드라마' 연출을 지시한다 — 침이 뚝뚝(drool), 입을 다물까 말까(twitch),
 * 확 다물다가 멈추는 페이크(chomp-fake), 악어새가 날아와 입을 못 다물게 함(bird).
 * 드라마는 서버가 결정해 방 전원(관전자 포함)에게 동기 전송 → 모두 같은 화면.
 *
 * 기존 핀볼 서버 프로세스에 Socket.IO 네임스페이스('/croc')로 마운트한다.
 * (핀볼 로직은 전혀 건드리지 않는다 — index.js 에서 mountCrocodile 만 호출)
 */

const { RateLimiter } = require('../../server/security');

// ── 상수 ──────────────────────────────────────────────────
const MAX_PLAYERS = 12;
const MAX_ROOMS = 1000;
const MIN_TEETH = 8;
const MAX_TEETH = 16;
const DEFAULT_TEETH = 12;
const GRACE_MS = 30000; // 끊긴 뒤 재접속 유예
const ROOM_GC_SWEEP_MS = 60000;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000; // 3시간 방치 시 폐기

// 주얼 톤 팔레트 (핀볼과 통일감)
const COLORS = [
  '#e0555f', '#f0c66b', '#63d29a', '#5aa2e8', '#a879e8', '#f28e5a',
  '#4fd6d0', '#f56a9e', '#9fd15a', '#c0b0a0', '#7f8cff', '#ffd24a',
];

const CHARACTERS = new Set(['crocodile', 'shark', 'dino']);

// 헷갈리는 문자(0/O,1/I) 제외
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode(existing) {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (existing.has(code));
  return code;
}

function sanitizeName(name) {
  const t = String(name || '').trim().slice(0, 12);
  return t || '플레이어';
}
function sanitizeTeeth(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, MIN_TEETH), MAX_TEETH) : DEFAULT_TEETH;
}
function sanitizeCharacter(c) {
  return CHARACTERS.has(c) ? c : 'crocodile';
}
function sanitizeMode(m) {
  return m === 'survival' ? 'survival' : 'single';
}

// 이모지 응원 화이트리스트 (핀볼 cheers 와 동일 취지)
const CHEER_SET = new Set(['👏', '😱', '😂', '🔥', '💀', '🐊', '🦈', '😭', '🎉', '😨', '🫣', '🙏']);
function sanitizeCheer(e) {
  return CHEER_SET.has(e) ? e : null;
}

/**
 * 안전한 이빨을 눌렀을 때의 '드라마' 연출을 서버가 결정한다.
 * 긴장(tension) = 지금까지 누른 비율. 후반부일수록 페이크가 잦고 강해진다.
 * 반환: 'none' | 'twitch' | 'drool' | 'chomp-fake' | 'bird'
 */
function rollDrama(pressedCount, teethCount) {
  const tension = pressedCount / teethCount; // 0 ~ 1
  const r = Math.random();
  // 초반엔 잔잔(none 위주), 후반엔 큰 페이크(chomp-fake/bird)가 자주 나온다.
  if (r < 0.34 - tension * 0.18) return 'none'; // 아무 일 없음 (초반 34% → 후반 16%)
  if (r < 0.55) return 'drool'; // 침이 뚝뚝
  if (r < 0.72) return 'twitch'; // 입이 움찔움찔
  // 큰 연출: 긴장이 높을수록 chomp-fake(확 다물다 멈춤) / bird(악어새 방해) 비중↑
  if (r < 0.72 + tension * 0.2) return 'bird'; // 악어새가 날아와 입을 벌려둠
  return 'chomp-fake'; // 확 다물다가 코앞에서 멈춤 (최고 페이크)
}

class CrocRooms {
  constructor(nsp) {
    this.nsp = nsp; // Socket.IO 네임스페이스 (/croc)
    this.rooms = new Map(); // code -> room
    this.socketRoom = new Map(); // socketId -> code
    this.limiter = {
      create: new RateLimiter(60000, 20),
      press: new RateLimiter(10000, 60),
      cheer: new RateLimiter(10000, 20),
    };
    this.gcTimer = setInterval(() => this.sweep(), ROOM_GC_SWEEP_MS);
    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const sockets = this.nsp.adapter.rooms.get(code);
      const connected = sockets ? sockets.size : 0;
      const idle = now - (room.lastActivity || 0) > ROOM_IDLE_MS;
      if ((connected === 0 && room.grace.size === 0) || idle) {
        for (const t of room.grace.values()) clearTimeout(t);
        room.grace.clear();
        if (room.turnTimer) clearTimeout(room.turnTimer);
        this.rooms.delete(code);
        this.nsp.to(code).emit('croc:closed');
      }
    }
  }

  handle(socket) {
    socket.on('croc:create', ({ name, character, teeth, mode, token } = {}, cb) => {
      if (typeof cb !== 'function') return;
      if (!this.limiter.create.allow(socket.id))
        return cb({ ok: false, error: '너무 자주 방을 만들고 있어요. 잠시 후 다시 시도해주세요.' });
      if (this.rooms.size >= MAX_ROOMS)
        return cb({ ok: false, error: '지금은 방이 너무 많아요. 잠시 후 다시 시도해주세요.' });
      this.leave(socket);
      const code = generateCode(this.rooms);
      const room = {
        code,
        hostId: socket.id,
        state: 'lobby', // 'lobby' | 'playing' | 'over'
        players: new Map(),
        spectators: new Map(),
        grace: new Map(),
        character: sanitizeCharacter(character),
        teeth: sanitizeTeeth(teeth),
        mode: sanitizeMode(mode),
        // 게임 진행 상태
        pressed: [], // bool[teeth]
        trap: -1, // 함정 이빨 인덱스 (서버 비밀)
        order: [], // 턴 순서 (playerId[])
        turnPtr: 0,
        round: 0,
        lastVictim: null,
        turnTimer: null,
        lastActivity: Date.now(),
      };
      this.rooms.set(code, room);
      this.addPlayer(room, socket, sanitizeName(name), token);
      cb({ ok: true, code });
    });

    socket.on('croc:join', ({ code, name, token } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const room = this.rooms.get(String(code || '').trim().toUpperCase());
      if (!room) return cb({ ok: false, error: '존재하지 않는 방 코드입니다.' });
      if (room.state !== 'lobby')
        return cb({ ok: false, error: '이미 게임이 진행 중인 방입니다. 관전으로 입장할 수 있어요.' });
      if (room.players.size >= MAX_PLAYERS)
        return cb({ ok: false, error: `방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)` });
      this.leave(socket);
      this.addPlayer(room, socket, sanitizeName(name), token);
      cb({ ok: true, code: room.code });
    });

    // 끊겼던 슬롯(같은 token)을 새 소켓으로 되살림
    socket.on('croc:resume', ({ code, token } = {}, cb) => {
      const done = (r) => typeof cb === 'function' && cb(r);
      const room = this.rooms.get(String(code || '').trim().toUpperCase());
      if (!room || !token) return done({ ok: false });
      let oldId = null, player = null;
      for (const [id, p] of room.players) {
        if (p.disconnected && p.token && p.token === token) { oldId = id; player = p; break; }
      }
      if (!oldId) return done({ ok: false });
      if (this.roomOf(socket)) this.leave(socket);
      if (room.grace.has(oldId)) { clearTimeout(room.grace.get(oldId)); room.grace.delete(oldId); }
      const newId = socket.id;
      room.players.delete(oldId);
      player.id = newId;
      player.disconnected = false;
      room.players.set(newId, player);
      if (room.hostId === oldId) room.hostId = newId;
      // 게임 진행 상태의 id 참조들도 갱신
      room.order = room.order.map((id) => (id === oldId ? newId : id));
      if (room.lastVictim === oldId) room.lastVictim = newId;
      this.socketRoom.set(newId, room.code);
      socket.join(room.code);
      done({ ok: true, code: room.code });
      this.broadcast(room);
    });

    socket.on('croc:spectate', ({ code } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const room = this.rooms.get(String(code || '').trim().toUpperCase());
      if (!room) return cb({ ok: false, error: '존재하지 않는 방 코드입니다.' });
      if (this.roomOf(socket)) this.leave(socket);
      room.spectators.set(socket.id, { id: socket.id });
      this.socketRoom.set(socket.id, room.code);
      socket.join(room.code);
      cb({ ok: true, code: room.code });
      this.broadcast(room);
    });

    socket.on('croc:leave', () => this.leave(socket));

    socket.on('croc:rename', ({ name } = {}, cb) => {
      const room = this.roomOf(socket);
      const player = room && room.players.get(socket.id);
      if (!room || !player) return typeof cb === 'function' && cb({ ok: false });
      if (room.state !== 'lobby')
        return typeof cb === 'function' && cb({ ok: false, error: '게임 중에는 닉네임을 바꿀 수 없어요.' });
      const clean = String(name || '').trim().slice(0, 12);
      if (!clean) return typeof cb === 'function' && cb({ ok: false, error: '닉네임을 입력해주세요.' });
      player.name = this.uniqueName(room, clean, socket.id);
      this.broadcast(room);
      if (typeof cb === 'function') cb({ ok: true, name: player.name });
    });

    socket.on('croc:setCharacter', ({ character } = {}) => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
      room.character = sanitizeCharacter(character);
      this.broadcast(room);
    });
    socket.on('croc:setTeeth', ({ teeth } = {}) => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
      room.teeth = sanitizeTeeth(teeth);
      this.broadcast(room);
    });
    socket.on('croc:setMode', ({ mode } = {}) => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
      room.mode = sanitizeMode(mode);
      this.broadcast(room);
    });

    socket.on('croc:start', () => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
      if (room.players.size < 1) return;
      this.startGame(room);
    });

    // 다시하기 → 로비로 (방장, 게임이 끝난 뒤에만 — 진행 중 판을 초기화할 수 없게)
    socket.on('croc:again', () => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id) return;
      if (room.state === 'playing') return;
      room.awaitingReload = false;
      if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
      room.state = 'lobby';
      for (const p of room.players.values()) p.alive = true;
      room.pressed = [];
      room.trap = -1;
      room.order = [];
      room.turnPtr = 0;
      room.round = 0;
      room.lastVictim = null;
      this.broadcast(room);
    });

    // 이빨 누르기 — 현재 턴 플레이어만
    socket.on('croc:press', ({ tooth } = {}) => {
      const room = this.roomOf(socket);
      if (!room || room.state !== 'playing') return;
      if (room.awaitingReload) return; // 서바이벌 리로드 연출 대기 중엔 입력 무시
      if (!this.limiter.press.allow(socket.id)) return;
      const currentId = room.order[room.turnPtr];
      if (currentId !== socket.id) return; // 내 턴 아님
      const i = Math.round(Number(tooth));
      if (!Number.isInteger(i) || i < 0 || i >= room.teeth) return;
      if (room.pressed[i]) return; // 이미 눌린 이빨
      this.doPress(room, i);
    });

    socket.on('croc:cheer', ({ emoji } = {}) => {
      const room = this.roomOf(socket);
      if (!room) return;
      if (!this.limiter.cheer.allow(socket.id)) return;
      const e = sanitizeCheer(emoji);
      if (!e) return;
      this.nsp.to(room.code).emit('croc:cheer', { emoji: e });
    });

    socket.on('disconnect', () => this.handleDisconnect(socket));
  }

  // ── 게임 로직 ────────────────────────────────────────────
  startGame(room) {
    room.state = 'playing';
    room.awaitingReload = false;
    room.round = (room.round || 0) + 1;
    room.pressed = new Array(room.teeth).fill(false);
    room.trap = Math.floor(Math.random() * room.teeth);
    for (const p of room.players.values()) p.alive = true;
    // 턴 순서: 현재 플레이어들을 무작위로 섞는다
    room.order = shuffle([...room.players.keys()]);
    room.turnPtr = 0;
    room.lastVictim = null;
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    this.broadcast(room);
    this.nsp.to(room.code).emit('croc:begin', {
      character: room.character,
      teeth: room.teeth,
      mode: room.mode,
      order: room.order.map((id) => this.pubPlayer(room, id)).filter(Boolean),
      turnId: room.order[0],
    });
  }

  doPress(room, i) {
    room.lastActivity = Date.now();
    room.pressed[i] = true;
    const byId = room.order[room.turnPtr];
    const by = this.pubPlayer(room, byId);

    if (i === room.trap) {
      // 🔴 함정 이빨! 진짜 쾅.
      const victim = room.players.get(byId);
      if (victim) victim.alive = false;
      room.lastVictim = byId;
      const alive = [...room.players.values()].filter((p) => p.alive);
      const gameOver = room.mode === 'single' || alive.length <= 1;

      this.nsp.to(room.code).emit('croc:bite', {
        tooth: i,
        victimId: byId,
        victimName: by ? by.name : '?',
        victimColor: by ? by.color : '#e0555f',
        character: room.character,
        mode: room.mode,
        gameOver,
        survivorId: gameOver && alive.length === 1 ? alive[0].id : null,
      });

      if (gameOver) {
        room.state = 'over';
        const survivor = alive.length === 1 ? this.pubPlayer(room, alive[0].id) : null;
        this.nsp.to(room.code).emit('croc:over', {
          mode: room.mode,
          loserId: byId,
          loserName: by ? by.name : '?',
          loserColor: by ? by.color : '#e0555f',
          survivorId: survivor ? survivor.id : null,
          survivorName: survivor ? survivor.name : null,
          survivorColor: survivor ? survivor.color : null,
          character: room.character,
        });
        this.broadcast(room);
      } else {
        // survival: 물린 사람 탈락 → 이빨 리셋 + 새 함정 재장전 후 계속
        room.pressed = new Array(room.teeth).fill(false);
        room.trap = Math.floor(Math.random() * room.teeth);
        // 다음 살아있는 플레이어로 턴 이동
        this.advanceTurn(room);
        // 리셋된 판을 클라에 알린다 (연출이 끝난 뒤 새 판 시작).
        // 그 사이엔 press 를 막는다 — 새 함정이 이미 재장전돼 있어 미리 누르면 안 됨.
        room.awaitingReload = true;
        if (room.turnTimer) clearTimeout(room.turnTimer);
        room.turnTimer = setTimeout(() => {
          room.turnTimer = null;
          room.awaitingReload = false;
          if (!this.rooms.has(room.code) || room.state !== 'playing') return;
          this.nsp.to(room.code).emit('croc:reload', {
            teeth: room.teeth,
            turnId: room.order[room.turnPtr],
            alive: room.order.map((id) => this.pubPlayer(room, id)).filter(Boolean).map((p) => ({ id: p.id, alive: p.alive })),
          });
          this.broadcast(room);
        }, 3200); // 물기 연출 시간 확보
      }
      return;
    }

    // 🟢 안전한 이빨 — 드라마 연출 결정 후 다음 턴
    const pressedCount = room.pressed.filter(Boolean).length;
    const remaining = room.teeth - pressedCount;
    const drama = rollDrama(pressedCount, room.teeth);
    this.advanceTurn(room);
    const nextTurnId = room.order[room.turnPtr];
    this.nsp.to(room.code).emit('croc:pressed', {
      tooth: i,
      byId,
      byName: by ? by.name : '?',
      byColor: by ? by.color : '#63d29a',
      drama,
      pressedCount,
      remaining,
      nextTurnId,
    });
    room.lastActivity = Date.now();
  }

  advanceTurn(room) {
    const n = room.order.length;
    if (n === 0) return;
    for (let step = 1; step <= n; step++) {
      const idx = (room.turnPtr + step) % n;
      const p = room.players.get(room.order[idx]);
      if (p && p.alive && !p.disconnected) { room.turnPtr = idx; return; }
    }
    // 살아있는 접속자가 없으면 그냥 다음 칸 (방어)
    room.turnPtr = (room.turnPtr + 1) % n;
  }

  // ── 방/플레이어 관리 ─────────────────────────────────────
  addPlayer(room, socket, name, token = null) {
    const usedColors = new Set([...room.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !usedColors.has(c)) || COLORS[room.players.size % COLORS.length];
    const finalName = this.uniqueName(room, name);
    room.players.set(socket.id, {
      id: socket.id,
      name: finalName,
      color,
      alive: true,
      disconnected: false,
      token: token ? String(token).slice(0, 64) : null,
    });
    this.socketRoom.set(socket.id, room.code);
    socket.join(room.code);
    this.broadcast(room);
  }

  uniqueName(room, name, excludeId = null) {
    const used = new Set(
      [...room.players.entries()].filter(([id]) => id !== excludeId).map(([, p]) => p.name)
    );
    if (!used.has(name)) return name;
    for (let i = 2; i < 100; i++) if (!used.has(`${name} ${i}`)) return `${name} ${i}`;
    return `${name} ${Math.floor(Math.random() * 900 + 100)}`;
  }

  handleDisconnect(socket) {
    const room = this.roomOf(socket);
    if (!room) return;
    this.socketRoom.delete(socket.id);
    socket.leave(room.code);
    if (room.spectators.has(socket.id)) { this.finalizeLeave(room, socket.id); return; }
    const player = room.players.get(socket.id);
    if (!player) return;
    player.disconnected = true;
    const oldId = socket.id;
    if (room.hostId === oldId) {
      const alt = [...room.players.values()].find((p) => !p.disconnected);
      if (alt) room.hostId = alt.id;
    }
    // 진행 중 현재 턴이 끊긴 사람이면 다음으로 넘긴다 (게임 멈춤 방지)
    if (room.state === 'playing' && room.order[room.turnPtr] === oldId) {
      this.advanceTurn(room);
      this.nsp.to(room.code).emit('croc:turn', { turnId: room.order[room.turnPtr] });
    }
    if (room.grace.has(oldId)) clearTimeout(room.grace.get(oldId));
    room.grace.set(oldId, setTimeout(() => {
      room.grace.delete(oldId);
      this.finalizeLeave(room, oldId);
    }, GRACE_MS));
    this.broadcast(room);
  }

  leave(socket) {
    const room = this.roomOf(socket);
    if (!room) return;
    this.socketRoom.delete(socket.id);
    socket.leave(room.code);
    if (room.grace.has(socket.id)) { clearTimeout(room.grace.get(socket.id)); room.grace.delete(socket.id); }
    this.finalizeLeave(room, socket.id);
  }

  finalizeLeave(room, id) {
    if (!this.rooms.has(room.code)) return;
    if (room.spectators.delete(id)) { this.broadcast(room); return; }
    if (!room.players.has(id)) return;
    room.players.delete(id);
    // 진행 중이면 턴 순서에서도 제거.
    // ⚠️ 나간 사람이 현재 턴보다 '앞 순번'이면 인덱스가 한 칸 밀리므로,
    //    현재 턴 주인의 id 를 기억해뒀다가 제거 후 다시 찾아 turnPtr 를 보정한다.
    const currentId = room.order[room.turnPtr];
    const wasCurrent = currentId === id;
    room.order = room.order.filter((x) => x !== id);
    if (!wasCurrent) {
      const idx = room.order.indexOf(currentId);
      if (idx >= 0) room.turnPtr = idx;
    }
    if (room.turnPtr >= room.order.length) room.turnPtr = 0;

    if (room.players.size === 0) {
      for (const t of room.grace.values()) clearTimeout(t);
      room.grace.clear();
      if (room.turnTimer) clearTimeout(room.turnTimer);
      this.rooms.delete(room.code);
      for (const specId of room.spectators.keys()) this.socketRoom.delete(specId);
      this.nsp.to(room.code).emit('croc:closed');
      return;
    }
    if (room.hostId === id) {
      const alt = [...room.players.values()].find((p) => !p.disconnected);
      room.hostId = alt ? alt.id : room.players.keys().next().value;
    }
    // 진행 중이고 현재 턴 주인이 나갔으면 턴 넘김 통지
    if (room.state === 'playing' && wasCurrent && room.order.length) {
      this.nsp.to(room.code).emit('croc:turn', { turnId: room.order[room.turnPtr] });
    }
    this.broadcast(room);
  }

  roomOf(socket) {
    const code = this.socketRoom.get(socket.id);
    return code ? this.rooms.get(code) : null;
  }

  pubPlayer(room, id) {
    const p = room.players.get(id);
    if (!p) return null;
    return { id: p.id, name: p.name, color: p.color, alive: !!p.alive, disconnected: !!p.disconnected };
  }

  broadcast(room) {
    room.lastActivity = Date.now();
    this.nsp.to(room.code).emit('croc:room', {
      code: room.code,
      hostId: room.hostId,
      state: room.state,
      character: room.character,
      teeth: room.teeth,
      mode: room.mode,
      maxPlayers: MAX_PLAYERS,
      players: [...room.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color,
        alive: !!p.alive, disconnected: !!p.disconnected,
      })),
      spectators: room.spectators ? room.spectators.size : 0,
      round: room.round || 0,
      // 진행 중이면 현재 판 상태 (중간 합류/관전용) — trap 은 절대 안 보낸다
      turnId: room.state === 'playing' ? room.order[room.turnPtr] : null,
      pressed: room.state === 'playing' ? room.pressed.slice() : null,
      lastVictim: room.lastVictim || null,
    });
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 기존 Socket.IO 서버에 악어 룰렛을 마운트한다.
 * @param {import('socket.io').Server} io
 */
function mountCrocodile(io) {
  const nsp = io.of('/croc');
  const manager = new CrocRooms(nsp);
  nsp.on('connection', (socket) => manager.handle(socket));
  return manager;
}

module.exports = { mountCrocodile, CrocRooms };
