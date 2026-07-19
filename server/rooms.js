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

// 🔌 재접속 유예: 끊긴 뒤 이 시간 안에 같은 토큰으로 돌아오면 자리를 되살린다
const GRACE_MS = 30000;

// 이어서 진행할 판 수 (1~10). 여러 판을 이어 최종 승자/벌칙자를 가린다.
const MAX_ROUNDS = 10;
function sanitizeRounds(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_ROUNDS) : 1;
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
    socket.on('room:create', ({ name, donorCode, winMode, ballsPerPlayer, itemsEnabled, password, rounds, token } = {}, cb) => {
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
        grace: new Map(), // 🔌 재접속 유예: 끊긴 socketId -> 제거 타이머
        game: null,
        mapId: 'classic',
        roundMaps: [], // 시리즈: 판마다 다른 맵 (mapId 배열, 비면 mapId 사용)
        winMode: winMode === 'last' ? 'last' : 'first', // 우승 조건: 먼저/늦게 골인
        ballsPerPlayer: sanitizeBallCount(ballsPerPlayer), // 인당 공 개수 (1~5)
        itemsEnabled: itemsEnabled !== false, // 아이템전(기본) / 노템전
        rounds: sanitizeRounds(rounds), // 이어서 진행할 판 수 (1=단판, 2+=시리즈)
        series: null, // 시리즈 진행 상태 (여러 판일 때만)
        seriesTimer: null, // 다음 판 자동 시작 타이머
        // 🔒 비밀방: 입장은 비번을 아는 사람만, 관전은 누구나. 서버 메모리에만 보관(클라 전송 X)
        password: String(password || '').trim().slice(0, 20) || null,
      };
      this.rooms.set(code, room);
      this.addPlayer(room, socket, sanitizeName(name), this.isDonor(donorCode), token);
      cb({ ok: true, code });
    });

    // 🔌 재접속: 끊겼던 슬롯(같은 token)을 새 소켓으로 되살린다
    socket.on('room:resume', ({ code, token } = {}, cb) => {
      const done = (r) => typeof cb === 'function' && cb(r);
      const room = this.rooms.get(String(code || '').trim().toUpperCase());
      if (!room || !token) return done({ ok: false });
      let oldId = null;
      let player = null;
      for (const [id, p] of room.players) {
        if (p.disconnected && p.token && p.token === token) { oldId = id; player = p; break; }
      }
      if (!oldId) return done({ ok: false }); // 유예 만료했거나 그런 슬롯 없음
      if (this.roomOf(socket)) this.leave(socket); // 다른 방에 있었으면 정리
      if (room.grace.has(oldId)) { clearTimeout(room.grace.get(oldId)); room.grace.delete(oldId); }
      const newId = socket.id;
      room.players.delete(oldId);
      player.id = newId;
      player.disconnected = false;
      room.players.set(newId, player);
      if (room.hostId === oldId) room.hostId = newId;
      if (room.game) room.game.rebindPlayer(oldId, newId);
      this.socketRoom.set(newId, room.code);
      socket.join(room.code);
      const payload = { ok: true, code: room.code, state: room.state };
      if (room.game && !room.game.over) payload.game = room.game.resumePayload(newId);
      done(payload);
      this.broadcastRoom(room);
    });

    socket.on('room:join', ({ code, name, donorCode, password, token } = {}, cb) => {
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
      this.addPlayer(room, socket, sanitizeName(name), this.isDonor(donorCode), token);
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
          rounds: r.rounds || 1, // 진행할 판 수 (시리즈)
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
          ...(map.width ? { width: map.width } : {}),
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

    socket.on('maps:save', ({ name, components, height, width, finish } = {}, cb) => {
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
          width,
          finish,
        },
        socketIp(socket) // 하루 생성 제한 집계용 (IP)
      );
      if (typeof cb === 'function') cb(result);
    });

    // 방장이 대기실에서 맵 선택 (단판 또는 시리즈 1판)
    socket.on('room:setMap', ({ mapId } = {}) => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
      if (!this.maps.get(mapId)) return;
      room.mapId = mapId;
      if (room.roundMaps.length) room.roundMaps[0] = mapId; // 시리즈 1판도 함께
      this.broadcastRoom(room);
    });

    // 방장이 대기실에서 특정 판(round)의 맵 선택 (시리즈)
    socket.on('room:setRoundMap', ({ round, mapId } = {}) => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
      if (!this.maps.get(mapId)) return;
      const idx = Math.round(Number(round)) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= (room.rounds || 1)) return;
      this._ensureRoundMaps(room);
      room.roundMaps[idx] = mapId;
      if (idx === 0) room.mapId = mapId; // 1판은 단일 맵 필드와 동기화
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

    // 방장이 대기실에서 진행할 판 수 변경 (여러 판 시리즈)
    socket.on('room:setRounds', ({ rounds } = {}) => {
      const room = this.roomOf(socket);
      if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
      room.rounds = sanitizeRounds(rounds);
      this._ensureRoundMaps(room); // 판 수에 맞춰 판별 맵 배열 크기 조정
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

    // 연결 종료: 플레이어는 잠깐 자리를 남겨(재접속 유예) 두었다가 정리
    socket.on('disconnect', () => this.handleDisconnect(socket));
  }

  /** 🔌 연결 끊김 — 플레이어는 유예 후 정리(재접속 허용), 관전자·미소속은 즉시 */
  handleDisconnect(socket) {
    const room = this.roomOf(socket);
    if (!room) return;
    this.socketRoom.delete(socket.id);
    socket.leave(room.code);
    // 관전자면 즉시 정리
    if (room.spectators.has(socket.id)) {
      this.finalizeLeave(room, socket.id);
      return;
    }
    const player = room.players.get(socket.id);
    if (!player) return;
    // 플레이어: 잠깐 자리를 유지(끊김 표시) → 같은 토큰으로 재접속하면 되살림
    player.disconnected = true;
    const oldId = socket.id;
    // 방장이 끊기면 방이 멈추지 않게 다른 접속자에게 즉시 승계 (돌아와도 방장은 안 돌려줌)
    if (room.hostId === oldId) {
      const alt = [...room.players.values()].find((p) => !p.disconnected);
      if (alt) room.hostId = alt.id;
    }
    if (room.grace.has(oldId)) clearTimeout(room.grace.get(oldId));
    room.grace.set(
      oldId,
      setTimeout(() => {
        room.grace.delete(oldId);
        this.finalizeLeave(room, oldId);
      }, GRACE_MS)
    );
    this.broadcastRoom(room);
  }

  /** 방에서 완전히 퇴장 (명시적 나가기 — 즉시) */
  leave(socket) {
    const room = this.roomOf(socket);
    if (!room) return;
    this.socketRoom.delete(socket.id);
    socket.leave(room.code);
    if (room.grace.has(socket.id)) {
      clearTimeout(room.grace.get(socket.id));
      room.grace.delete(socket.id);
    }
    this.finalizeLeave(room, socket.id);
  }

  /** 슬롯 실제 제거 (유예 만료·명시적 나가기 공용) */
  finalizeLeave(room, id) {
    if (!this.rooms.has(room.code)) return;
    // 관전자였다면 목록에서만 제거
    if (room.spectators.delete(id)) {
      this.broadcastRoom(room);
      return;
    }
    if (!room.players.has(id)) return;
    room.players.delete(id);
    if (room.game) room.game.removePlayer(id);

    if (room.players.size === 0) {
      if (room.game) room.game.stop();
      if (room.seriesTimer) clearTimeout(room.seriesTimer); // 자동 다음 판 타이머 정리
      for (const t of room.grace.values()) clearTimeout(t); // 남은 유예 타이머 정리
      room.grace.clear();
      room.series = null;
      this.rooms.delete(room.code);
      for (const specId of room.spectators.keys()) this.socketRoom.delete(specId);
      this.io.to(room.code).emit('room:closed');
      return;
    }
    // 방장이 나가면 접속 중인 다음 사람에게 승계
    if (room.hostId === id) {
      const alt = [...room.players.values()].find((p) => !p.disconnected);
      room.hostId = alt ? alt.id : room.players.keys().next().value;
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

  addPlayer(room, socket, name, isDonor = false, token = null) {
    const usedColors = new Set([...room.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !usedColors.has(c)) || COLORS[0];
    const finalName = this.uniqueName(room, name);
    room.players.set(socket.id, {
      id: socket.id,
      name: finalName,
      color,
      isDonor,
      token: token ? String(token).slice(0, 64) : null, // 🔌 재접속 식별용
    });
    this.socketRoom.set(socket.id, room.code);
    socket.join(room.code);
    this.broadcastRoom(room);
  }

  roomOf(socket) {
    const code = this.socketRoom.get(socket.id);
    return code ? this.rooms.get(code) : null;
  }

  /** roundMaps 배열을 rounds 길이에 맞춘다 (빈 칸은 mapId 로 채움) */
  _ensureRoundMaps(room) {
    const n = room.rounds || 1;
    if (!Array.isArray(room.roundMaps)) room.roundMaps = [];
    if (n <= 1) {
      room.roundMaps = [];
      return;
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      const id = room.roundMaps[i];
      out.push(this.maps.get(id) ? id : room.mapId);
    }
    room.roundMaps = out;
  }

  launchGame(room, { autoPilot }) {
    if (room.players.size < 1) return;
    // 여러 판 시리즈: 일반 게임에서 rounds>1 이고 아직 시리즈가 시작 안 됐으면 준비
    if (!autoPilot && !room.series && (room.rounds || 1) > 1) {
      const scores = new Map();
      const meta = new Map();
      for (const p of room.players.values()) {
        scores.set(p.id, 0);
        meta.set(p.id, { name: p.name, color: p.color });
      }
      this._ensureRoundMaps(room); // 판별 맵 확정
      room.series = { total: room.rounds, roundNo: 1, scores, meta, roundResults: [] };
    }
    // 이번 판에 쓸 맵: 시리즈면 판별 맵, 아니면 단일 맵
    const roundIdx = room.series ? room.series.roundNo - 1 : 0;
    const mapId = (room.roundMaps && room.roundMaps[roundIdx]) || room.mapId;
    const mapDef = this.maps.get(mapId) || this.maps.get('classic');
    room.state = 'playing';
    room.game = new Game(
      room,
      this.io,
      mapDef,
      (ranking) => this.onRoundEnd(room, ranking, autoPilot),
      { autoPilot }
    );
    room.game.start();
    this.broadcastRoom(room);
  }

  /** 한 판 종료 콜백 — 단판이면 대기실로, 시리즈면 점수 합산 후 다음 판/최종결과 */
  onRoundEnd(room, ranking, autoPilot) {
    this.stats.record(ranking); // 전체 순위(리더보드)에 매 판 누적
    room.game = null;
    const series = room.series;

    // 단판(또는 올랜덤): 기존 동작 — 바로 대기실로
    if (autoPilot || !series) {
      room.state = 'lobby';
      this.broadcastRoom(room);
      return;
    }

    // 이번 판 점수 합산: N명 중 1등 N점 … 꼴찌 1점
    const n = ranking.length;
    for (const r of ranking) {
      series.scores.set(r.playerId, (series.scores.get(r.playerId) || 0) + (n - r.rank + 1));
      if (!series.meta.has(r.playerId)) series.meta.set(r.playerId, { name: r.name, color: r.color });
    }
    series.roundResults.push({ round: series.roundNo, ranking });

    if (series.roundNo < series.total) {
      // 다음 판 예고 후 자동 시작 (그 사이 방은 계속 'playing' 상태로 난입 차단)
      const nextNo = series.roundNo + 1;
      series.roundNo = nextNo;
      const startInMs = 6000;
      const nextMapDef = this.maps.get((room.roundMaps && room.roundMaps[nextNo - 1]) || room.mapId);
      this.io.to(room.code).emit('series:next', {
        round: nextNo,
        total: series.total,
        standings: this.seriesStandings(series),
        startInMs,
        mapName: nextMapDef ? nextMapDef.name : null,
      });
      if (room.seriesTimer) clearTimeout(room.seriesTimer);
      room.seriesTimer = setTimeout(() => {
        room.seriesTimer = null;
        if (this.rooms.has(room.code) && room.players.size >= 1 && room.series) {
          this.launchGame(room, { autoPilot: false });
        }
      }, startInMs);
    } else {
      // 최종 판 종료 → 최종 결과 발표
      this.io.to(room.code).emit('series:over', {
        total: series.total,
        standings: this.seriesStandings(series),
        rounds: series.roundResults,
      });
      room.series = null;
      room.state = 'lobby';
      this.broadcastRoom(room);
    }
  }

  /** 시리즈 누적 순위표 (점수 내림차순, place 부여) */
  seriesStandings(series) {
    const rows = [...series.scores.entries()].map(([pid, score]) => {
      const m = series.meta.get(pid) || {};
      return { playerId: pid, name: m.name || '(나감)', color: m.color || '#888', score };
    });
    rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    rows.forEach((r, i) => (r.place = i + 1));
    return rows;
  }

  broadcastRoom(room) {
    const mapDef = this.maps.get(room.mapId) || this.maps.get('classic');
    // 시리즈: 판별 맵 목록 (이름 포함) — 판 수>1 일 때만
    let roundMaps = null;
    if ((room.rounds || 1) > 1) {
      this._ensureRoundMaps(room);
      roundMaps = room.roundMaps.map((id, i) => {
        const m = this.maps.get(id) || mapDef;
        return { round: i + 1, mapId: m.id, mapName: m.name };
      });
    }
    this.io.to(room.code).emit('room:update', {
      code: room.code,
      hostId: room.hostId,
      state: room.state,
      maxPlayers: MAX_PLAYERS,
      // ⚠️ token 은 절대 클라로 내보내지 않는다 (재접속 식별용 비밀)
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        isDonor: !!p.isDonor,
        disconnected: !!p.disconnected,
      })),
      spectators: room.spectators ? room.spectators.size : 0,
      map: { id: mapDef.id, name: mapDef.name, author: mapDef.author },
      winMode: room.winMode || 'first',
      ballsPerPlayer: room.ballsPerPlayer || 1,
      itemsEnabled: room.itemsEnabled !== false,
      rounds: room.rounds || 1, // 진행할 판 수 (시리즈)
      roundMaps, // 시리즈: 판별 맵 [{round, mapId, mapName}] (단판이면 null)
      // 시리즈 진행 중이면 현재 판/총 판 (대기실·게임 화면 표시용)
      series: room.series ? { roundNo: room.series.roundNo, total: room.series.total } : null,
      locked: !!room.password, // 🔒 비밀방 여부
    });
  }
}

module.exports = { RoomManager };
