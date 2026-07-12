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

const MAX_PARTICIPANTS = 500; // 공(참가자) 상한 — 시뮬레이션 성능 기준
const PLAYBACK_DELAY_MS = 8000; // 리플레이 다운로드 여유 시간
const RECENT_NAMES = 30;

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

function participantColor(i) {
  return `hsl(${Math.round((i * 137.5) % 360)}, 72%, 62%)`;
}

class EventManager {
  constructor(io, mapStore) {
    this.io = io;
    this.maps = mapStore;
    this.events = new Map(); // code -> event
    this.socketEvent = new Map(); // socketId -> code
  }

  handleConnection(socket) {
    socket.on('event:create', (_payload, cb) => {
      if (typeof cb !== 'function') return;
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
      this.joinSocket(socket, ev);
      cb({ ok: true, ...this.summary(ev), replay: this.replayInfo(ev) });
      this.broadcast(ev);
    });

    // 참가 등록 (공 1개 배정) — 추첨 시작 전까지만
    socket.on('event:register', ({ name } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const ev = this.eventOf(socket);
      if (!ev) return cb({ ok: false, error: '이벤트에 먼저 입장해주세요.' });
      if (ev.state !== 'lobby')
        return cb({ ok: false, error: '이미 추첨이 시작되었습니다.' });
      if (ev.registeredSockets.has(socket.id))
        return cb({ ok: false, error: '이미 참가 등록을 했습니다.' });
      if (ev.participants.length >= MAX_PARTICIPANTS)
        return cb({ ok: false, error: `참가 인원이 가득 찼습니다. (최대 ${MAX_PARTICIPANTS}명)` });

      const cleanName = String(name || '').trim().slice(0, 12);
      if (!cleanName) return cb({ ok: false, error: '이름을 입력해주세요.' });

      const id = ev.participants.length;
      ev.participants.push({ id, name: cleanName, color: participantColor(id) });
      ev.registeredSockets.add(socket.id);
      cb({ ok: true, participantId: id });
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

    // 재추첨 (재생이 끝난 후, 호스트 전용)
    socket.on('event:again', () => {
      const ev = this.eventOf(socket);
      if (!ev || ev.hostId !== socket.id || ev.state !== 'playing') return;
      ev.state = 'lobby';
      ev.replayGz = null;
      ev.replayMeta = null;
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
      replayUrl: `/api/replay/${ev.code}`,
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
    this.io.to(this.roomKey(ev)).emit('event:update', this.summary(ev));
  }

  /** HTTP 리플레이 서빙용 */
  getReplayGz(code) {
    const ev = this.events.get(String(code || '').toUpperCase());
    return ev && ev.replayGz ? ev.replayGz : null;
  }
}

module.exports = { EventManager, MAX_PARTICIPANTS };
