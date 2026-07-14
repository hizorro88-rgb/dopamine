/**
 * 게임방 관리: 방 생성 / 초대 코드로 입장 / 시작 / 아이템 사용 / 퇴장
 */

const { Game } = require('./game');
const { MapStore } = require('./maps');
const { StatsStore } = require('./stats');
const { ReviewStore } = require('./reviews');
const { RateLimiter } = require('./security');

// 아이템전(직접 아이템 사용)은 최대 10명 — 그 이상은 이벤트 추첨 모드 사용
const MAX_PLAYERS = 10;
// 동시에 존재할 수 있는 방 총량 (스팸/메모리 고갈 방지)
const MAX_ROOMS = 2000;
// 주얼 톤 팔레트: 가넷, 샴페인, 진주, 에메랄드, 사파이어, 자수정, 은, 구리, 청록, 올리브
const COLORS = [
  '#b23a48',
  '#d4b06a',
  '#e9e4d6',
  '#2f8f6b',
  '#4a7fc1',
  '#8a63c0',
  '#a7b0ba',
  '#c07a3e',
  '#41969b',
  '#7d8a4a',
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

/** 소켓의 클라이언트 IP (nginx/Cloudflare 뒤에서는 X-Forwarded-For 우선) */
function socketIp(socket) {
  const xff = socket.handshake.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return socket.handshake.address || 'unknown';
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
    // 소켓당 남용 방지 레이트 리미터 (분당 허용 횟수)
    this.limiter = {
      create: new RateLimiter(60000, 20), // 방 생성
      save: new RateLimiter(60000, 20), // 맵 저장
      review: new RateLimiter(60000, 30), // 후기
      donor: new RateLimiter(60000, 20), // 후원자 코드 확인(브루트포스 방지)
    };
  }

  isDonor(donorCode) {
    return !!(this.donors && this.donors.findByCode(donorCode));
  }

  handleConnection(socket) {
    socket.on('room:create', ({ name, donorCode, winMode, ballsPerPlayer, itemsEnabled, password } = {}, cb) => {
      if (typeof cb !== 'function') return;
      if (!this.limiter.create.allow(socket.id))
        return cb({ ok: false, error: '너무 자주 방을 만들고 있어요. 잠시 후 다시 시도해주세요.' });
      if (this.rooms.size >= MAX_ROOMS)
        return cb({ ok: false, error: '지금은 방이 너무 많아요. 잠시 후 다시 시도해주세요.' });
      this.leave(socket); // 이전 방 정리 (누수·중복 소속 방지)
      const code = generateCode(this.rooms);
      const room = {
        code,
        hostId: socket.id,
        state: 'lobby', // 'lobby' | 'playing'
        players: new Map(),
        spectators: new Map(), // 관전자 (공·아이템 없음, 인원 제한 없음)
        game: null,
        mapId: 'classic',
        winMode: winMode === 'last' ? 'last' : 'first', // 우승 조건: 먼저/늦게 골인
        ballsPerPlayer: sanitizeBallCount(ballsPerPlayer), // 인당 공 개수 (1~5)
        itemsEnabled: itemsEnabled !== false, // 아이템전(기본) / 노템전
        // 🔒 비밀방: 입장은 비번을 아는 사람만, 관전은 누구나. 서버 메모리에만 보관(클라 전송 X)
        password: String(password || '').trim().slice(0, 20) || null,
      };
      this.rooms.set(code, room);
      this.addPlayer(room, socket, sanitizeName(name), this.isDonor(donorCode));
      cb({ ok: true, code });
    });

    socket.on('room:join', ({ code, name, donorCode, password } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const room = this.rooms.get(String(code || '').trim().toUpperCase());
      if (!room) return cb({ ok: false, error: '존재하지 않는 방 코드입니다.' });
      if (room.state === 'playing')
        return cb({ ok: false, error: '게임이 진행 중인 방입니다. 잠시 후 다시 시도해주세요.' });
      // 🔒 비밀방: 비번 확인 (틀리면 locked 플래그로 응답 → 클라가 비번 입력창을 띄운다). 관전은 이 검사 없음.
      if (room.password) {
        const given = String(password || '').trim();
        if (given !== room.password)
          return cb({
            ok: false,
            locked: true,
            error: given ? '비밀번호가 틀렸습니다.' : '비밀번호가 필요한 방입니다.',
          });
      }
      if (room.players.size >= MAX_PLAYERS)
        return cb({ ok: false, error: `방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)` });
      this.leave(socket); // 이전 방 정리 (누수·중복 소속 방지)
      this.addPlayer(room, socket, sanitizeName(name), this.isDonor(donorCode));
      cb({ ok: true, code: room.code });
    });

    // 홈 화면 공개 방 목록 — 누구나 보고, 입장하거나 관전할 수 있다
    socket.on('rooms:list', (_payload, cb) => {
      if (typeof cb !== 'function') return;
      const list = [...this.rooms.values()].map((r) => {
        const mapDef = this.maps.get(r.mapId) || this.maps.get('classic');
        const host = r.players.get(r.hostId);
        return {
          code: r.code,
          state: r.state, // 'lobby' | 'playing'
          hostName: host ? host.name : '?',
          players: r.players.size,
          maxPlayers: MAX_PLAYERS,
          spectators: r.spectators.size,
          mapName: mapDef.name,
          winMode: r.winMode || 'first',
          ballsPerPlayer: r.ballsPerPlayer || 1,
          itemsEnabled: r.itemsEnabled !== false,
          locked: !!r.password, // 🔒 비밀방 여부(비번 자체는 절대 보내지 않음)
        };
      });
      // 게임 중인 방 먼저(구경거리!), 그 다음 사람 많은 순
      list.sort(
        (a, b) =>
          (b.state === 'playing') - (a.state === 'playing') || b.players - a.players
      );
      cb({ ok: true, rooms: list });
    });

    // 관전 입장 — 게임 중이어도, 방이 가득 차도 언제든 가능
    socket.on('room:spectate', ({ code } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const room = this.rooms.get(String(code || '').trim().toUpperCase());
      if (!room) return cb({ ok: false, error: '존재하지 않는 방 코드입니다.' });
      if (this.roomOf(socket)) this.leave(socket); // 다른 방에 있었다면 정리
      room.spectators.set(socket.id, { id: socket.id });
      this.socketRoom.set(socket.id, room.code);
      socket.join(room.code);
      // 게임이 이미 진행 중이면 현재 상태를 통째로 전달 (중간 합류)
      const game = room.game && !room.game.over ? room.game.spectatorPayload() : null;
      cb({ ok: true, code: room.code, game });
      this.broadcastRoom(room);
    });

    // 방 나가기 (관전자·플레이어 공용)
    socket.on('room:leave', () => this.leave(socket));

    // 대기실에서 자신의 닉네임 변경 (QR로 바로 입장한 뒤 각자 개명)
    socket.on('room:rename', ({ name } = {}, cb) => {
      const room = this.roomOf(socket);
      const player = room && room.players.get(socket.id);
      if (!room || !player) {
        if (typeof cb === 'function') cb({ ok: false, error: '방에 있지 않습니다.' });
        return;
      }
      if (room.state !== 'lobby') {
        if (typeof cb === 'function') cb({ ok: false, error: '게임 중에는 닉네임을 바꿀 수 없어요.' });
        return;
      }
      const clean = String(name || '').trim().slice(0, 12);
      if (!clean) {
        if (typeof cb === 'function') cb({ ok: false, error: '닉네임을 입력해주세요.' });
        return;
      }
      player.name = this.uniqueName(room, clean, socket.id);
      this.broadcastRoom(room);
      if (typeof cb === 'function') cb({ ok: true, name: player.name });
    });

    // 후원자 코드 확인 (홈 화면 즉시 피드백용)
    socket.on('donor:check', ({ code } = {}, cb) => {
      if (typeof cb !== 'function') return;
      // 코드 브루트포스 방지 (분당 20회)
      if (!this.limiter.donor.allow(socket.id)) return cb({ ok: false });
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

    // 맵 상세 (갤러리 구경용 — 구성요소 포함 전체 정의)
    socket.on('maps:get', ({ mapId } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const map = this.maps.get(mapId);
      if (!map) return cb({ ok: false, error: '존재하지 않는 맵입니다.' });
      cb({
        ok: true,
        map: {
          id: map.id,
          name: map.name,
          author: map.author,
          height: map.height,
          components: map.components,
          ...(map.finish ? { finish: map.finish } : {}),
        },
      });
    });

    // ── 맵 후기 (커뮤니티) ──────────────────────────
    socket.on('reviews:list', ({ mapId } = {}, cb) => {
      if (typeof cb !== 'function') return;
      if (!this.maps.get(mapId)) return cb({ ok: false, error: '존재하지 않는 맵입니다.' });
      cb({ ok: true, ...this.reviews.list(mapId) });
    });

    socket.on('reviews:add', ({ mapId, name, rating, text } = {}, cb) => {
      if (typeof cb !== 'function') return;
      if (!this.limiter.review.allow(socket.id))
        return cb({ ok: false, error: '후기 작성이 너무 잦아요. 잠시 후 다시 시도해주세요.' });
      if (!this.maps.get(mapId)) return cb({ ok: false, error: '존재하지 않는 맵입니다.' });
      // 방에 있으면 그 닉네임을 우선 사용 (사칭 방지)
      const room = this.roomOf(socket);
      const player = room ? room.players.get(socket.id) : null;
      cb(this.reviews.add({ mapId, name: player ? player.name : name, rating, text }));
    });

    socket.on('maps:save', ({ name, components, height, finish } = {}, cb) => {
      if (!this.limiter.save.allow(socket.id)) {
        if (typeof cb === 'function')
          cb({ ok: false, error: '맵 저장이 너무 잦아요. 잠시 후 다시 시도해주세요.' });
        return;
      }
      const room = this.roomOf(socket);
      const player = room ? room.players.get(socket.id) : null;
      const result = this.maps.save(
        {
          name,
          author: player ? player.name : '익명',
          components,
          height,
          finish,
        },
        socketIp(socket) // 하루 생성 제한 집계용 (IP)
      );
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

    // 방장이 대기실에서 아이템전 / 노템전 변경
    socket.on('room:setItems', ({ itemsEnabled } = {}) => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
      room.itemsEnabled = itemsEnabled !== false;
      this.broadcastRoom(room);
    });

    // ⏩ 방장이 게임 중 배속 변경
    socket.on('game:setSpeed', ({ mult } = {}) => {
      const room = this.roomOf(socket);
      if (!room || !room.game || room.hostId !== socket.id) return;
      room.game.setSpeed(mult);
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

    socket.on('disconnect', () => this.leave(socket));
  }

  /** 방에서 퇴장 (연결 종료·자발적 나가기 공용) */
  leave(socket) {
    const room = this.roomOf(socket);
    if (!room) return;
    this.socketRoom.delete(socket.id);
    socket.leave(room.code);

    // 관전자였다면 목록에서만 제거하면 끝
    if (room.spectators.delete(socket.id)) {
      this.broadcastRoom(room);
      return;
    }

    room.players.delete(socket.id);
    if (room.game) room.game.removePlayer(socket.id);

    if (room.players.size === 0) {
      if (room.game) room.game.stop();
      this.rooms.delete(room.code);
      // 남아있던 관전자들에게 방이 사라졌음을 알림
      for (const specId of room.spectators.keys()) this.socketRoom.delete(specId);
      this.io.to(room.code).emit('room:closed');
      return;
    }
    // 방장이 나가면 다음 사람에게 방장 승계
    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value;
    }
    this.broadcastRoom(room);
  }

  /** 방 안에서 겹치는 닉네임이면 번호를 붙여 구분 (홍길동 → 홍길동 2)
   *  @param excludeId 이 소켓의 현재 이름은 비교에서 제외 (본인 개명 시 자기와 충돌 방지) */
  uniqueName(room, name, excludeId = null) {
    const used = new Set(
      [...room.players.entries()].filter(([id]) => id !== excludeId).map(([, p]) => p.name)
    );
    if (!used.has(name)) return name;
    for (let i = 2; i < 100; i++) {
      const candidate = `${name} ${i}`;
      if (!used.has(candidate)) return candidate;
    }
    return `${name} ${Math.floor(Math.random() * 900 + 100)}`;
  }

  addPlayer(room, socket, name, isDonor = false) {
    const usedColors = new Set([...room.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !usedColors.has(c)) || COLORS[0];
    const finalName = this.uniqueName(room, name);
    room.players.set(socket.id, { id: socket.id, name: finalName, color, isDonor });
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
      spectators: room.spectators ? room.spectators.size : 0,
      map: { id: mapDef.id, name: mapDef.name, author: mapDef.author },
      winMode: room.winMode || 'first',
      ballsPerPlayer: room.ballsPerPlayer || 1,
      itemsEnabled: room.itemsEnabled !== false,
      locked: !!room.password, // 🔒 비밀방 여부
    });
  }
}

module.exports = { RoomManager };
