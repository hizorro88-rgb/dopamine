const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');
const { DonorStore } = require('./donors');
const { RateLimiter } = require('./security');

const app = express();
// nginx 뒤에 있을 때 실제 클라이언트 IP(X-Forwarded-For)를 신뢰
app.set('trust proxy', true);
app.disable('x-powered-by');

// 기본 보안 헤더 (helmet 의존성 없이 최소 구성)
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

// 정적 자산: HTML/JS/CSS 는 항상 재검증(no-cache)해서 프록시(Cloudflare 등)·브라우저가
// 옛 버전을 붙잡아 코드 변경이 반영되지 않는 문제를 막는다. ETag 로 안 바뀐 건 304 로 가볍게 처리.
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);
app.use(express.json({ limit: '64kb' })); // 과대 요청 바디 차단

const donors = new DonorStore();
const { VisitStore } = require('./visits');
const visits = new VisitStore();

// 방문 집계 (방문자 id 기준 하루 1회) + 현재 카운트 반환 — IP당 분당 30회로 제한
const visitLimiter = new RateLimiter(60000, 30);
app.post('/api/visit', (req, res) => {
  if (!visitLimiter.allow(req.ip)) return res.status(429).json({ error: 'too many requests' });
  res.json(visits.visit((req.body || {}).vid));
});

// 클라이언트 설정: 후원 링크 (환경변수로 덮어쓰기 가능, 'off' 면 버튼 숨김)
const DEFAULT_DONATION_URL = 'https://qr.kakaopay.com/Ej8euQo2R'; // 운영자 카카오페이
app.get('/api/config', (_req, res) => {
  const url = process.env.DONATION_URL || DEFAULT_DONATION_URL;
  res.json({
    donationUrl: url === 'off' ? '' : url,
    donationLabel: process.env.DONATION_LABEL || '💛 서버비 후원하기 (카카오페이)',
  });
});

// 후원자 명예의 전당 (공개)
app.get('/api/donors', (_req, res) => {
  res.json({ donors: donors.list() });
});

// 상수 시간 문자열 비교 (타이밍 공격 방지)
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// 후원자 등록 (관리자 전용) → 후원자 코드 발급 — 키 미설정 시 항상 닫힘(fail-closed)
app.post('/api/admin/donors', (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key || !safeEqual(req.get('x-admin-key'), key)) {
    return res.status(403).json({ ok: false, error: '관리자 키가 올바르지 않습니다.' });
  }
  res.json(donors.add(req.body || {}));
});

const server = http.createServer(app);

// Socket.IO Origin 허용목록: ALLOWED_ORIGINS 환경변수를 설정하면 교차 사이트 접속을 차단한다.
// (미설정 시 기존 동작 유지 — LAN/DDNS/도메인 접속을 깨뜨리지 않기 위함)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const io = new Server(server, {
  maxHttpBufferSize: 1e5, // 100KB — 과대 소켓 프레임 차단
  ...(allowedOrigins.length
    ? {
        cors: { origin: allowedOrigins },
        allowRequest: (req, done) => {
          const origin = req.headers.origin;
          // Origin 헤더가 없는 비브라우저 클라이언트는 허용, 그 외엔 허용목록만
          done(null, !origin || allowedOrigins.includes(origin));
        },
      }
    : {}),
});

const { EventManager } = require('./events');

const rooms = new RoomManager(io, donors);
const events = new EventManager(io, rooms.maps);
io.on('connection', (socket) => {
  rooms.handleConnection(socket);
  events.handleConnection(socket);
});

// 이벤트 리플레이 (gzip 으로 미리 압축해둔 것을 그대로 서빙)
app.get('/api/replay/:code', (req, res) => {
  const gz = events.getReplayGz(req.params.code);
  if (!gz) return res.status(404).json({ error: '리플레이가 없습니다.' });
  res.set('Content-Type', 'application/json');
  res.set('Content-Encoding', 'gzip');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(gz);
});

// 전체 순위 (누적 전적 리더보드, 공개)
app.get('/api/leaderboard', (_req, res) => {
  res.json({ leaderboard: rooms.stats.list() });
});

// 최후의 안전망: 한 요청/핸들러에서 예외가 새어나와도 프로세스 전체가 죽지 않도록 한다.
// (개별 핸들러는 각자 방어하지만, 놓친 예외로 전 서버가 내려가는 것을 막는다)
process.on('uncaughtException', (err) => {
  console.error('처리되지 않은 예외:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('처리되지 않은 Promise 거부:', err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎱 핀볼 공뽑기 서버 실행 중: http://localhost:${PORT}`);
});
