/**
 * 게임방 관리: 방 생성 / 초대 코드로 입장 / 시작 / 아이템 사용 / 퇴장
 */

const { Game } = require('./game');
const { MapStore } = require('./maps');

const MAX_PLAYERS = 8;
const COLORS = [
  '#ff5d5d',
  '#ffb03a',
  '#ffe14d',
  '#5dde78',
  '#4dc9ff',
  '#7a7aff',
  '#c86dff',
  '#ff7ad9',
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

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // code -> room
    this.socketRoom = new Map(); // socketId -> code
    this.maps = new MapStore();
  }

  handleConnection(socket) {
    socket.on('room:create', ({ name } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const code = generateCode(this.rooms);
      const room = {
        code,
        hostId: socket.id,
        state: 'lobby', // 'lobby' | 'playing'
        players: new Map(),
        game: null,
        mapId: 'classic',
      };
      this.rooms.set(code, room);
      this.addPlayer(room, socket, sanitizeName(name));
      cb({ ok: true, code });
    });

    socket.on('room:join', ({ code, name } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const room = this.rooms.get(String(code || '').trim().toUpperCase());
      if (!room) return cb({ ok: false, error: '존재하지 않는 방 코드입니다.' });
      if (room.state === 'playing')
        return cb({ ok: false, error: '게임이 진행 중인 방입니다. 잠시 후 다시 시도해주세요.' });
      if (room.players.size >= MAX_PLAYERS)
        return cb({ ok: false, error: `방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)` });
      this.addPlayer(room, socket, sanitizeName(name));
      cb({ ok: true, code: room.code });
    });

    socket.on('game:start', () => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
      if (room.players.size < 1) return;
      const mapDef = this.maps.get(room.mapId) || this.maps.get('classic');
      room.state = 'playing';
      room.game = new Game(room, this.io, mapDef, () => {
        room.state = 'lobby';
        room.game = null;
        this.broadcastRoom(room);
      });
      room.game.start();
      this.broadcastRoom(room);
    });

    // ── 맵 ──────────────────────────────────────────
    socket.on('maps:list', (_payload, cb) => {
      if (typeof cb === 'function') cb({ ok: true, maps: this.maps.list() });
    });

    socket.on('maps:save', ({ name, components } = {}, cb) => {
      const room = this.roomOf(socket);
      const player = room ? room.players.get(socket.id) : null;
      const result = this.maps.save({
        name,
        author: player ? player.name : '익명',
        components,
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

  addPlayer(room, socket, name) {
    const usedColors = new Set([...room.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !usedColors.has(c)) || COLORS[0];
    room.players.set(socket.id, { id: socket.id, name, color });
    this.socketRoom.set(socket.id, room.code);
    socket.join(room.code);
    this.broadcastRoom(room);
  }

  roomOf(socket) {
    const code = this.socketRoom.get(socket.id);
    return code ? this.rooms.get(code) : null;
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
    });
  }
}

module.exports = { RoomManager };
