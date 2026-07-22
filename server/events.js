/**
 * 이벤트 추첨 방 관리
 * ────────────────────
 * 흐름: 이벤트 생성 → 링크 공유 → 수백 명 참가 등록(공 1개씩) + 시청자 무제한
 *       → 호스트가 추첨 시작 → 서버가 오프라인 시뮬레이션 녹화
 *       → 전원에게 리플레이 URL + 시작 시각 방송 → 동기화 재생
 *
 * 리플레이는 gzip 으로 한 번 압축해두고 HTTP 로 서빙하므로
 * 시청자 수천 명도 각자 파일 한 번만 내려받으면 된다.
 */

const zlib = require('zlib');
const { simulateEvent } = require('./eventsim');
const { RateLimiter } = require('./security');
const { sanitizeCheer } = require('./cheers');

// 공(참가자) 상한 — 아이템 없는 순수 낙하라 1000명까지 클라 60fps 실측 확인.
// 서버 시뮬 시간은 인원에 초선형으로 늘어(사양 낮으면 더 오래) 환경변수로 조절 가능.
const MAX_PARTICIPANTS = Math.min(3000, Math.max(2, Number(process.env.EVENT_MAX_PARTICIPANTS) || 1000));
const MAX_EVENTS = 1000; // 동시 이벤트 총량 (스팸/메모리 고갈 방지)
const PLAYBACK_DELAY_MS = 8000; // 리플레이 다운로드 여유 시간
const RECENT_NAMES = 30;
const GC_SWEEP_MS = 60000; // 유휴 이벤트 청소 주기
const EVENT_IDLE_MS = 60 * 60 * 1000; // 1시간 활동 없으면 폐기 (리플레이 메모리 회수)

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

/** 동명이인이면 뒤에 (2), (3)… 을 붙여 유일화 (12자 넘으면 이름을 줄여 맞춤) */
function dedupeName(name, participants) {
  const taken = new Set(participants.map((p) => p.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = `(${n})`;
    const base = name.slice(0, Math.max(1, 12 - suffix.length));
    const candidate = base + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

function participantColor(i) {
  // 채도를 낮춘 주얼 톤 (원색 무지개 방지)
  return `hsl(${Math.round((i * 137.5) % 360)}, 42%, 58%)`;
}

class EventManager {
  constructor(io, mapStore, recordings) {
    this.io = io;
    this.maps = mapStore;
    this.recordings = recordings || null; // 결과 영구 저장(공유 링크)용
    this.events = new Map(); // code -> event
    this.socketEvent = new Map(); // socketId -> code
    this.limiter = {
      create: new RateLimiter(60000, 20),
      register: new RateLimiter(60000, 30),
      cheer: new RateLimiter(10000, 20), // 이모지 응원 스팸 방지(10초 20회)
      record: new RateLimiter(60000, 10), // 결과 저장 스팸 방지
    };
    // 🧹 유휴/고아 이벤트 청소 — 리플레이 버퍼 메모리 회수 (테스트에서 프로세스 안 붙잡게 unref)
    this.gcTimer = setInterval(() => this.sweep(), GC_SWEEP_MS);
    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  /** 접속자 없거나 오래 방치된 이벤트 정리 */
  sweep() {
    const now = Date.now();
    for (const [code, ev] of this.events) {
      if (ev.state === 'simulating') continue; // 시뮬 완료 로직이 처리
      const sockets = this.io.sockets.adapter.rooms.get(this.roomKey(ev));
      const empty = !sockets || sockets.size === 0;
      const idle = now - (ev.lastActivity || 0) > EVENT_IDLE_MS;
      if (empty || idle) this.events.delete(code);
    }
  }

  handleConnection(socket) {
    socket.on('event:create', (_payload, cb) => {
      if (typeof cb !== 'function') return;
      if (!this.limiter.create.allow(socket.id))
        return cb({ ok: false, error: '너무 자주 이벤트를 만들고 있어요. 잠시 후 다시 시도해주세요.' });
      if (this.events.size >= MAX_EVENTS)
        return cb({ ok: false, error: '지금은 이벤트가 너무 많아요. 잠시 후 다시 시도해주세요.' });
      this.detach(socket); // 이전 이벤트 정리 (누수 방지)
      const code = generateCode(this.events);
      const ev = {
        code,
        hostId: socket.id,
        state: 'lobby', // 'lobby' | 'simulating' | 'playing'
        mapId: 'classic',
        participants: [], // [{id, name, color}]
        registeredSockets: new Set(), // 중복 등록 방지
        replayGz: null,
        replayMeta: null, // { startAt, durationMs }
        replayVersion: 0, // 재추첨마다 +1 → 리플레이 URL 캐시 무효화
        recordingCode: null, // 이 리플레이를 영구 저장했다면 공유 코드
        recordingVersion: -1, // recordingCode 가 어느 replayVersion 의 것인지
        lastActivity: Date.now(),
      };
      this.events.set(code, ev);
      this.joinSocket(socket, ev);
      cb({ ok: true, code });
      this.broadcast(ev);
    });

    socket.on('event:join', ({ code } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const ev = this.events.get(String(code || '').trim().toUpperCase());
      if (!ev) return cb({ ok: false, error: '존재하지 않는 이벤트 코드입니다.' });
      this.detach(socket); // 이전 이벤트 정리 (누수 방지)
      this.joinSocket(socket, ev);
      cb({ ok: true, ...this.summary(ev), replay: this.replayInfo(ev) });
      this.broadcast(ev);
    });

    // 참가 등록 (공 배정) — 추첨 시작 전까지만.
    // 콤마로 여러 이름을 한 번에 받을 수 있어, 한 사람이 여러 명을 넣고 혼자 돌릴 수 있다.
    socket.on('event:register', ({ name } = {}, cb) => {
      if (typeof cb !== 'function') return;
      if (!this.limiter.register.allow(socket.id))
        return cb({ ok: false, error: '요청이 너무 잦아요. 잠시 후 다시 시도해주세요.' });
      const ev = this.eventOf(socket);
      if (!ev) return cb({ ok: false, error: '이벤트에 먼저 입장해주세요.' });
      if (ev.state !== 'lobby')
        return cb({ ok: false, error: '이미 추첨이 시작되었습니다.' });
      if (ev.participants.length >= MAX_PARTICIPANTS)
        return cb({ ok: false, error: `참가 인원이 가득 찼습니다. (최대 ${MAX_PARTICIPANTS}명)` });

      // 콤마로 구분해 여러 이름을 한 번에 등록 (한 번 호출당 최대 100명 — 과대 요청 방지)
      const names = String(name || '')
        .split(',')
        .map((s) => s.trim().slice(0, 12))
        .filter(Boolean)
        .slice(0, 100);
      if (names.length === 0) return cb({ ok: false, error: '이름을 입력해주세요.' });

      const added = [];
      for (const nm of names) {
        if (ev.participants.length >= MAX_PARTICIPANTS) break;
        const id = ev.participants.length;
        // 동명이인 구분 — 추첨 결과에서 누가 당첨됐는지 헷갈리지 않게 (2), (3) 부여
        const uniqueName = dedupeName(nm, ev.participants);
        ev.participants.push({ id, name: uniqueName, color: participantColor(id) });
        added.push({ id, name: uniqueName });
      }
      ev.registeredSockets.add(socket.id);
      if (added.length === 0)
        return cb({ ok: false, error: `참가 인원이 가득 찼습니다. (최대 ${MAX_PARTICIPANTS}명)` });
      // participantId 는 하위호환(단일 등록) — 첫 번째로 추가된 공
      cb({ ok: true, participantId: added[0].id, added, full: ev.participants.length >= MAX_PARTICIPANTS });
      this.broadcast(ev);
    });

    socket.on('event:setMap', ({ mapId } = {}) => {
      const ev = this.eventOf(socket);
      if (!ev || ev.hostId !== socket.id || ev.state !== 'lobby') return;
      if (!this.maps.get(mapId)) return;
      ev.mapId = mapId;
      this.broadcast(ev);
    });

    // 추첨 시작 → 오프라인 시뮬레이션 → 리플레이 방송
    socket.on('event:start', async () => {
      const ev = this.eventOf(socket);
      if (!ev || ev.hostId !== socket.id || ev.state !== 'lobby') return;
      if (ev.participants.length < 2) {
        socket.emit('event:error', { error: '참가자가 2명 이상이어야 합니다.' });
        return;
      }
      ev.state = 'simulating';
      this.broadcast(ev);

      try {
        const mapDef = this.maps.get(ev.mapId) || this.maps.get('classic');
        const replay = await simulateEvent(mapDef, ev.participants, (pct) => {
          this.io.to(this.roomKey(ev)).emit('event:simprogress', { pct });
        });
        // 시뮬 도중 전원이 나갔으면 무거운 리플레이를 만들지 않고 이벤트 폐기 (누수 방지)
        if (!this.events.has(ev.code)) return;
        const stillHere = this.io.sockets.adapter.rooms.get(this.roomKey(ev));
        if (!stillHere || stillHere.size === 0) {
          this.events.delete(ev.code);
          return;
        }
        ev.replayVersion += 1; // 캐시 무효화용 버전 증가
        ev.replayGz = zlib.gzipSync(Buffer.from(JSON.stringify(replay)));
        ev.replayMeta = {
          startAt: Date.now() + PLAYBACK_DELAY_MS,
          durationMs: replay.durationMs,
        };
        ev.state = 'playing';
        this.io.to(this.roomKey(ev)).emit('event:ready', this.replayInfo(ev));
        this.broadcast(ev);
      } catch (err) {
        console.error('이벤트 시뮬레이션 실패:', err);
        ev.state = 'lobby';
        this.io.to(this.roomKey(ev)).emit('event:error', { error: '추첨 생성에 실패했습니다. 다시 시도해주세요.' });
        this.broadcast(ev);
      }
    });

    // 🎉 이모지 응원 — 이벤트 관람 중 모두가 서로에게 띄운다
    socket.on('event:cheer', ({ emoji } = {}) => {
      const ev = this.eventOf(socket);
      if (!ev) return;
      if (!this.limiter.cheer.allow(socket.id)) return; // 스팸 방지
      const e = sanitizeCheer(emoji);
      if (!e) return;
      this.io.to(this.roomKey(ev)).emit('event:cheer', { emoji: e });
    });

    // 🎬 결과 녹화 저장 → 영구 공유 코드 발급 (누구나 요청 가능, 결과가 준비된 뒤)
    socket.on('event:record', (_payload, cb) => {
      if (typeof cb !== 'function') return;
      const ev = this.eventOf(socket);
      if (!ev) return cb({ ok: false, error: '이벤트에 먼저 입장해주세요.' });
      if (!ev.replayGz || ev.state !== 'playing')
        return cb({ ok: false, error: '아직 저장할 결과가 없습니다. 추첨을 먼저 진행해주세요.' });
      if (!this.recordings) return cb({ ok: false, error: '녹화 저장을 사용할 수 없습니다.' });
      // 같은 리플레이를 이미 저장했으면 그 코드를 재사용 (중복 저장 방지)
      if (ev.recordingCode && ev.recordingVersion === ev.replayVersion)
        return cb({ ok: true, code: ev.recordingCode });
      if (!this.limiter.record.allow(socket.id))
        return cb({ ok: false, error: '저장 요청이 너무 잦아요. 잠시 후 다시 시도해주세요.' });
      const mapDef = this.maps.get(ev.mapId) || this.maps.get('classic');
      const res = this.recordings.save(ev.replayGz, {
        mapName: mapDef ? mapDef.name : '',
        count: ev.participants.length,
      });
      if (!res.ok) return cb(res);
      ev.recordingCode = res.code;
      ev.recordingVersion = ev.replayVersion;
      cb({ ok: true, code: res.code });
    });

    // 이벤트에서 나가기 (홈으로) — 접속만 해제, 이미 등록한 추첨 엔트리는 유지
    socket.on('event:leave', () => this.detach(socket));

    // 재추첨 (재생이 끝난 후, 호스트 전용)
    socket.on('event:again', () => {
      const ev = this.eventOf(socket);
      if (!ev || ev.hostId !== socket.id || ev.state !== 'playing') return;
      ev.state = 'lobby';
      ev.replayGz = null;
      ev.replayMeta = null;
      // 새 추첨을 준비하는 것이므로, 이전 결과의 저장 코드는 그대로 두고(공유 링크는 영구 유지)
      // 다음 추첨은 새 리플레이 버전이라 record 시 새 코드가 발급된다.
      this.broadcast(ev);
    });

    socket.on('disconnect', () => {
      const ev = this.eventOf(socket);
      if (!ev) return;
      this.socketEvent.delete(socket.id);
      // 참가 등록은 유지 (추첨 엔트리), 접속만 해제
      if (ev.hostId === socket.id) {
        // 남은 접속자에게 호스트 승계
        const roomSockets = this.io.sockets.adapter.rooms.get(this.roomKey(ev));
        const next = roomSockets ? [...roomSockets][0] : null;
        if (next) ev.hostId = next;
        else if (ev.state === 'lobby') {
          this.events.delete(ev.code);
          return;
        }
      }
      const roomSockets = this.io.sockets.adapter.rooms.get(this.roomKey(ev));
      if (!roomSockets || roomSockets.size === 0) {
        if (ev.state !== 'simulating') this.events.delete(ev.code);
        return;
      }
      this.broadcast(ev);
    });
  }

  joinSocket(socket, ev) {
    this.socketEvent.set(socket.id, ev.code);
    socket.join(this.roomKey(ev));
  }

  /** 소켓을 현재 이벤트에서 분리 (다른 이벤트로 이동하기 전에 호출) */
  detach(socket) {
    const ev = this.eventOf(socket);
    if (!ev) return;
    this.socketEvent.delete(socket.id);
    socket.leave(this.roomKey(ev));
    // 호스트가 떠나면 대기 중 이벤트는 승계, 아무도 없으면 정리
    if (ev.hostId === socket.id) {
      const roomSockets = this.io.sockets.adapter.rooms.get(this.roomKey(ev));
      const next = roomSockets ? [...roomSockets][0] : null;
      if (next) ev.hostId = next;
    }
    // 아무도 안 남았으면 정리 (시뮬 중이면 완료 후 정리 로직이 처리)
    const roomSockets = this.io.sockets.adapter.rooms.get(this.roomKey(ev));
    if ((!roomSockets || roomSockets.size === 0) && ev.state !== 'simulating') {
      this.events.delete(ev.code);
    }
  }

  eventOf(socket) {
    const code = this.socketEvent.get(socket.id);
    return code ? this.events.get(code) : null;
  }

  roomKey(ev) {
    return 'ev:' + ev.code;
  }

  replayInfo(ev) {
    if (!ev.replayMeta) return null;
    return {
      // ?v= 로 재추첨마다 URL을 바꿔 브라우저·프록시 캐시가 옛 리플레이를 주지 않게 함
      replayUrl: `/api/replay/${ev.code}?v=${ev.replayVersion}`,
      startAt: ev.replayMeta.startAt,
      durationMs: ev.replayMeta.durationMs,
      serverNow: Date.now(),
    };
  }

  summary(ev) {
    const mapDef = this.maps.get(ev.mapId) || this.maps.get('classic');
    const roomSockets = this.io.sockets.adapter.rooms.get(this.roomKey(ev));
    return {
      code: ev.code,
      state: ev.state,
      hostId: ev.hostId,
      participantCount: ev.participants.length,
      maxParticipants: MAX_PARTICIPANTS,
      recent: ev.participants.slice(-RECENT_NAMES).map((p) => p.name),
      viewers: roomSockets ? roomSockets.size : 0,
      map: { id: mapDef.id, name: mapDef.name },
    };
  }

  broadcast(ev) {
    ev.lastActivity = Date.now(); // 활동 갱신 (유휴 GC 기준)
    this.io.to(this.roomKey(ev)).emit('event:update', this.summary(ev));
  }

  /** HTTP 리플레이 서빙용 */
  getReplayGz(code) {
    const ev = this.events.get(String(code || '').toUpperCase());
    return ev && ev.replayGz ? ev.replayGz : null;
  }
}

module.exports = { EventManager, MAX_PARTICIPANTS };
