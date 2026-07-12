/**
 * 게임방 관리: 방 생성 / 초대 코드로 입장 / 시작 / 아이템 사용 / 퇴장
 */

const { Game } = require('./game');
const { MapStore } = require('./maps');
const { StatsStore } = require('./stats');
const { ReviewStore } = require('./reviews');

// 아이템전(직접 아이템 사용)은 최대 10명 — 그 이상은 이벤트 추첨 모드 사용
const MAX_PLAYERS = 10;
const COLORS = [
  '#ff5d5d',
  '#ffb03a',
  '#ffe14d',
  '#5dde78',
  '#4dc9ff',
  '#7a7aff',
  '#c86dff',
  '#ff7ad9',
  '#5fe3c4',
  '#e08c5f',
];

// 헷갈리는 문자(0/O, 1/I) 제외
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(existing) {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (existing.has(code));
  return code;
}

function sanitizeName(name) {
  const trimmed = String(name || '').trim().slice(0, 12);
  return trimmed || '플레이어';
}

function sanitizeBallCount(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 5) : 1;
}

class RoomManager {
  constructor(io, donorStore) {
    this.io = io;
    this.rooms = new Map(); // code -> room
    this.socketRoom = new Map(); // socketId -> code
    this.maps = new MapStore();
    this.donors = donorStore || null;
    this.stats = new StatsStore();
    this.reviews = new ReviewStore();
  }

  isDonor(donorCode) {
    return !!(this.donors && this.donors.findByCode(donorCode));
  }

  handleConnection(socket) {
    socket.on('room:create', ({ name, donorCode, winMode, ballsPerPlayer } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const code = generateCode(this.rooms);
      const room = {
        code,
        hostId: socket.id,
        state: 'lobby', // 'lobby' | 'playing'
        players: new Map(),
        game: null,
        mapId: 'classic',
        winMode: winMode === 'last' ? 'last' : 'first', // 우승 조건: 먼저/늦게 골인
        ballsPerPlayer: sanitizeBallCount(ballsPerPlayer), // 인당 공 개수 (1~5)
      };
      this.rooms.set(code, room);
      this.addPlayer(room, socket, sanitizeName(name), this.isDonor(donorCode));
      cb({ ok: true, code });
    });

    socket.on('room:join', ({ code, name, donorCode } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const room = this.rooms.get(String(code || '').trim().toUpperCase());
      if (!room) return cb({ ok: false, error: '존재하지 않는 방 코드입니다.' });
      if (room.state === 'playing')
        return cb({ ok: false, error: '게임이 진행 중인 방입니다. 잠시 후 다시 시도해주세요.' });
      if (room.players.size >= MAX_PLAYERS)
        return cb({ ok: false, error: `방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)` });
      this.addPlayer(room, socket, sanitizeName(name), this.isDonor(donorCode));
      cb({ ok: true, code: room.code });
    });

    // 후원자 코드 확인 (홈 화면 즉시 피드백용)
    socket.on('donor:check', ({ code } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const donor = this.donors ? this.donors.findByCode(code) : null;
      cb(donor ? { ok: true, name: donor.name } : { ok: false });
    });

    socket.on('game:start', () => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
      this.launchGame(room, { autoPilot: false });
    });

    // 🎲 올랜덤: 맵/공 개수/우승 조건/낙하 타이밍/아이템 전부 시스템이 결정, 전원 관전
    socket.on('game:startRandom', () => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
      const mapsList = this.maps.list();
      room.mapId = mapsList[Math.floor(Math.random() * mapsList.length)].id;
      room.winMode = Math.random() < 0.5 ? 'first' : 'last';
      room.ballsPerPlayer = 1 + Math.floor(Math.random() * 5);
      this.launchGame(room, { autoPilot: true });
    });

    // ── 맵 ──────────────────────────────────────────
    // 평점(베이지안 점수)이 높은 맵부터 정렬해서 반환
    socket.on('maps:list', (_payload, cb) => {
      if (typeof cb !== 'function') return;
      const maps = this.maps
        .list()
        .map((m) => {
          const s = this.reviews.summary(m.id);
          return { ...m, rating: s.avg, reviews: s.count };
        })
        .sort(
          (a, b) =>
            this.reviews.score(b.id) - this.reviews.score(a.id) || b.reviews - a.reviews
        );
      cb({ ok: true, maps });
    });

    // ── 맵 후기 (커뮤니티) ──────────────────────────
    socket.on('reviews:list', ({ mapId } = {}, cb) => {
      if (typeof cb !== 'function') return;
      if (!this.maps.get(mapId)) return cb({ ok: false, error: '존재하지 않는 맵입니다.' });
      cb({ ok: true, ...this.reviews.list(mapId) });
    });

    socket.on('reviews:add', ({ mapId, name, rating, text } = {}, cb) => {
      if (typeof cb !== 'function') return;
      if (!this.maps.get(mapId)) return cb({ ok: false, error: '존재하지 않는 맵입니다.' });
      // 방에 있으면 그 닉네임을 우선 사용 (사칭 방지)
      const room = this.roomOf(socket);
      const player = room ? room.players.get(socket.id) : null;
      cb(this.reviews.add({ mapId, name: player ? player.name : name, rating, text }));
    });

    socket.on('maps:save', ({ name, components, height } = {}, cb) => {
      const room = this.roomOf(socket);
      const player = room ? room.players.get(socket.id) : null;
      const result = this.maps.save({
        name,
        author: player ? player.name : '익명',
        components,
        height,
      });
      if (typeof cb === 'function') cb(result);
    });

    // 방장이 대기실에서 맵 선택
    socket.on('room:setMap', ({ mapId } = {}) => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
      if (!this.maps.get(mapId)) return;
      room.mapId = mapId;
      this.broadcastRoom(room);
    });

    // 방장이 대기실에서 우승 조건 변경
    socket.on('room:setWinMode', ({ winMode } = {}) => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
      if (winMode !== 'first' && winMode !== 'last') return;
      room.winMode = winMode;
      this.broadcastRoom(room);
    });

    // 방장이 대기실에서 인당 공 개수 변경
    socket.on('room:setBalls', ({ ballsPerPlayer } = {}) => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
      room.ballsPerPlayer = sanitizeBallCount(ballsPerPlayer);
      this.broadcastRoom(room);
    });

    // 셔플 단계에서 방장이 낙하 시작
    socket.on('game:drop', () => {
      const room = this.roomOf(socket);
      if (!room || !room.game || room.hostId !== socket.id) return;
      room.game.drop();
    });

    socket.on('game:useItem', ({ slotIndex, targetId } = {}, cb) => {
      const room = this.roomOf(socket);
      if (!room || !room.game) return;
      const error = room.game.useItem(socket.id, Number(slotIndex), targetId);
      if (typeof cb === 'function') cb({ ok: !error, error });
    });

    socket.on('disconnect', () => {
      const room = this.roomOf(socket);
      if (!room) return;
      this.socketRoom.delete(socket.id);
      room.players.delete(socket.id);
      if (room.game) room.game.removePlayer(socket.id);

      if (room.players.size === 0) {
        if (room.game) room.game.stop();
        this.rooms.delete(room.code);
        return;
      }
      // 방장이 나가면 다음 사람에게 방장 승계
      if (room.hostId === socket.id) {
        room.hostId = room.players.keys().next().value;
      }
      this.broadcastRoom(room);
    });
  }

  addPlayer(room, socket, name, isDonor = false) {
    const usedColors = new Set([...room.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !usedColors.has(c)) || COLORS[0];
    room.players.set(socket.id, { id: socket.id, name, color, isDonor });
    this.socketRoom.set(socket.id, room.code);
    socket.join(room.code);
    this.broadcastRoom(room);
  }

  roomOf(socket) {
    const code = this.socketRoom.get(socket.id);
    return code ? this.rooms.get(code) : null;
  }

  launchGame(room, { autoPilot }) {
    if (room.players.size < 1) return;
    const mapDef = this.maps.get(room.mapId) || this.maps.get('classic');
    room.state = 'playing';
    room.game = new Game(
      room,
      this.io,
      mapDef,
      (ranking) => {
        this.stats.record(ranking); // 전체 순위(리더보드)에 누적
        room.state = 'lobby';
        room.game = null;
        this.broadcastRoom(room);
      },
      { autoPilot }
    );
    room.game.start();
    this.broadcastRoom(room);
  }

  broadcastRoom(room) {
    const mapDef = this.maps.get(room.mapId) || this.maps.get('classic');
    this.io.to(room.code).emit('room:update', {
      code: room.code,
      hostId: room.hostId,
      state: room.state,
      maxPlayers: MAX_PLAYERS,
      players: [...room.players.values()],
      map: { id: mapDef.id, name: mapDef.name, author: mapDef.author },
      winMode: room.winMode || 'first',
      ballsPerPlayer: room.ballsPerPlayer || 1,
    });
  }
}

module.exports = { RoomManager };
