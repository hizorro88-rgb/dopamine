require('./loadenv').loadEnv(); // .env → process.env (config 를 읽는 require 들보다 먼저)
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

const fs = require('fs');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 정적 자산: HTML/JS/CSS 는 항상 재검증(no-cache). index.html 자동 서빙은 끈다(아래에서 버전 주입).
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);
app.use(express.json({ limit: '64kb' })); // 과대 요청 바디 차단

// index.html 을 낼 때 자산 URL(client.js 등)에 버전 토큰(파일 mtime 기반)을 붙여
// 파일이 바뀌면 URL 도 바뀌게 한다 → Cloudflare/브라우저가 옛 버전을 붙잡는 문제를 근본적으로 차단.
function assetVersion() {
  let m = 0;
  for (const f of ['client.js', 'style.css', 'components.js', 'index.html']) {
    try {
      m = Math.max(m, fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs);
    } catch {
      /* 파일 없으면 무시 */
    }
  }
  return Math.floor(m).toString(36);
}
function serveIndex(_req, res) {
  let html;
  try {
    html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  } catch {
    return res.status(500).send('index.html not found');
  }
  const v = assetVersion();
  html = html.replace(/(\/(?:client|components|qrcode)\.js|\/style\.css)(?=")/g, `$1?v=${v}`);
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html);
}
// 게임은 /pinball, 관리자는 /dopaman/pinball 로 서빙한다.
// (dopamine.me.kr 하위에 여러 게임을 붙일 수 있도록 경로를 분리)
app.get(['/pinball', '/dopaman/pinball'], serveIndex);
// 편의 리다이렉트: 루트/구경로 → 새 경로 (쿼리스트링 유지 — ?room=CODE 초대링크 호환)
const qs = (req) => {
  const i = req.originalUrl.indexOf('?');
  return i >= 0 ? req.originalUrl.slice(i) : '';
};
app.get('/', (req, res) => res.redirect(302, '/pinball' + qs(req)));
app.get('/dopaman', (req, res) => res.redirect(302, '/dopaman/pinball' + qs(req)));

const donors = new DonorStore();
const { VisitStore } = require('./visits');
const visits = new VisitStore();

// 방문 집계 (방문자 id 기준 하루 1회) + 현재 카운트 반환 — IP당 분당 30회로 제한
const visitLimiter = new RateLimiter(60000, 30);
app.post('/api/visit', (req, res) => {
  if (!visitLimiter.allow(req.ip)) return res.status(429).json({ error: 'too many requests' });
  res.json(visits.visit((req.body || {}).vid));
});

// 클라이언트 설정: 후원 링크 (관리자 페이지에서 변경 가능, 'off' 면 버튼 숨김)
const settings = require('./settings');
app.get('/api/config', (_req, res) => {
  const url = settings.get('donationUrl');
  res.json({
    donationUrl: url === 'off' ? '' : url,
    donationLabel: settings.get('donationLabel'),
  });
});

// 후원자 명예의 전당 (공개)
app.get('/api/donors', (_req, res) => {
  res.json({ donors: donors.list() });
});

// 아이템 도감 (공개) — 모든 아이템 메타데이터를 누구나 볼 수 있게
const { ITEMS, itemMeta, itemChances } = require('./items');
app.get('/api/items', (_req, res) => {
  const chances = itemChances();
  res.json({ items: Object.values(ITEMS).map((it) => ({ ...itemMeta(it), ...chances[it.id] })) });
});

// 개선 요청 / 개발자에게 한마디 — 제출은 공개(레이트리밋), 열람은 관리자만
const { FeedbackStore } = require('./feedback');
const feedback = new FeedbackStore();
const feedbackLimiter = new RateLimiter(60000, 6); // IP당 분당 6회
app.post('/api/feedback', (req, res) => {
  if (!feedbackLimiter.allow(req.ip))
    return res.status(429).json({ ok: false, error: '너무 자주 보내고 있어요. 잠시 후 다시 시도해주세요.' });
  res.json(feedback.add(req.body || {}));
});

// 상수 시간 문자열 비교 (타이밍 공격 방지)
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// 관리자 인증: ADMIN_KEY 미설정 시 항상 닫힘(fail-closed) + 상수 시간 비교
function adminOk(req) {
  const key = process.env.ADMIN_KEY;
  return !!key && safeEqual(req.get('x-admin-key'), key);
}

// 관리자 가드: 통과하면 true, 아니면 사유별 응답을 쓰고 false.
//  · 서버에 ADMIN_KEY 자체가 없으면(가장 흔한 "열기가 안돼" 원인) 그 사실을 명확히 알린다.
function requireAdmin(req, res) {
  if (!process.env.ADMIN_KEY) {
    res.status(503).json({
      ok: false,
      error: '서버에 ADMIN_KEY가 설정되어 있지 않습니다. .env 또는 start.bat 에 ADMIN_KEY=원하는키 를 지정하고 서버를 재시작하세요.',
    });
    return false;
  }
  if (!adminOk(req)) {
    res.status(403).json({ ok: false, error: '관리자 키가 올바르지 않습니다.' });
    return false;
  }
  return true;
}

// 후원자 등록 (관리자 전용) → 후원자 코드 발급
app.post('/api/admin/donors', (req, res) => {
  if (!requireAdmin(req, res)) return;
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

// ── 관리자: 유저 맵 관리 (목록/삭제/재편집) — x-admin-key 필요 ──
app.get('/api/admin/maps', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, maps: rooms.maps.adminList() });
});
app.post('/api/admin/maps/delete', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(rooms.maps.remove((req.body || {}).id));
});
app.post('/api/admin/maps/update', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { id, name, components, height, width, finish, autoKickers } = req.body || {};
  res.json(rooms.maps.update(id, { name, components, height, width, finish, autoKickers }));
});

// ── 관리자: 런타임 설정 (후원 링크·낙하 배속·아이템 소개·하루 맵 제한 등) ──
app.get('/api/admin/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, settings: settings.all(), itemDefs: require('./items').configurableItems() });
});
app.post('/api/admin/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(settings.update(req.body || {}));
});

// ── 관리자: 개선 요청 열람 (일반 사용자는 볼 수 없음) ──
app.get('/api/admin/feedback', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, feedback: feedback.list() });
});
const { RecordingStore } = require('./recordings');
const recordings = new RecordingStore();
rooms.recordings = recordings; // 🎬 방 게임 결과 녹화 저장에도 같은 저장소 사용
const events = new EventManager(io, rooms.maps, recordings);
io.on('connection', (socket) => {
  rooms.handleConnection(socket);
  events.handleConnection(socket);
});

// 🐊 악어 룰렛 (별도 게임) — 같은 프로세스에 Socket.IO 네임스페이스('/croc')로 마운트.
//    핀볼 로직과 완전히 분리되어 있고, 정적 자산은 apps/crocodile/public 에서 /crocodile 로 서빙한다.
const { mountCrocodile } = require('../apps/crocodile/croc');
mountCrocodile(io);
const CROC_DIR = path.join(__dirname, '..', 'apps', 'crocodile', 'public');
app.use(
  '/crocodile',
  express.static(CROC_DIR, {
    index: false,
    redirect: false, // '/crocodile' → '/crocodile/' 자동 리다이렉트 끄기 (아래 serveCroc 로 넘긴다)
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);
// 악어 룰렛 index.html — 자산 URL 에 버전 토큰(mtime)을 붙여 캐시 스테일 방지 (핀볼과 동일 기법)
function serveCroc(_req, res) {
  let html;
  try {
    html = fs.readFileSync(path.join(CROC_DIR, 'index.html'), 'utf8');
  } catch {
    return res.status(500).send('crocodile index.html not found');
  }
  let m = 0;
  for (const f of ['croc-client.js', 'croc-style.css', 'index.html']) {
    try { m = Math.max(m, fs.statSync(path.join(CROC_DIR, f)).mtimeMs); } catch {}
  }
  const v = Math.floor(m).toString(36);
  html = html.replace(/(\/crocodile\/(?:croc-client\.js|croc-style\.css))(?=")/g, `$1?v=${v}`);
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html);
}
app.get(['/crocodile', '/crocodile/'], serveCroc);

// 이벤트 리플레이 (gzip 으로 미리 압축해둔 것을 그대로 서빙)
app.get('/api/replay/:code', (req, res) => {
  const gz = events.getReplayGz(req.params.code);
  if (!gz) return res.status(404).json({ error: '리플레이가 없습니다.' });
  res.set('Content-Type', 'application/json');
  res.set('Content-Encoding', 'gzip');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(gz);
});

// 🎬 저장된 결과 녹화 서빙 (영구 공유 링크 ?replay=CODE 용) — 디스크에서 gzip 그대로 흘려보낸다.
app.get('/api/recording/:code', (req, res) => {
  const gz = recordings.getGz(req.params.code);
  if (!gz) return res.status(404).json({ error: '저장된 결과를 찾을 수 없습니다.' });
  res.set('Content-Type', 'application/json');
  res.set('Content-Encoding', 'gzip');
  res.set('Cache-Control', 'public, max-age=31536000, immutable'); // 영구 (코드가 곧 버전)
  res.send(gz);
});

// 🧪 맵 에디터 즉석 테스트 — 저장 없이 현재 맵을 시뮬레이션해 리플레이를 돌려준다.
//    이벤트 시뮬레이터(결정론적)를 그대로 재사용. 응답이 커질 수 있어 gzip 으로 보낸다.
const zlibMod = require('zlib');
const { simulateEvent: simulateMapTest } = require('./eventsim');
const mapTestLimiter = new RateLimiter(60000, 20);
app.post('/api/map/test', express.json({ limit: '256kb' }), async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!mapTestLimiter.allow(ip || 'anon'))
    return res.status(429).json({ ok: false, error: '테스트가 너무 잦아요. 잠시 후 다시 시도해주세요.' });
  const { components, height, width, finish, autoKickers, balls } = req.body || {};
  const v = rooms.maps._validate({ name: '(테스트)', components, height, width, finish, autoKickers }, 2000);
  if (!v.ok) return res.status(400).json(v);
  const n = Math.min(24, Math.max(2, Math.round(Number(balls) || 12)));
  const participants = Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `테스트${i + 1}`,
    color: `hsl(${Math.round((i * 137.5) % 360)}, 55%, 58%)`,
  }));
  const mapDef = {
    id: '__test__', name: '(테스트)',
    height: v.cleanHeight, width: v.cleanWidth, components: v.validated,
    ...(v.cleanFinish ? { finish: v.cleanFinish } : {}),
    ...(v.cleanAutoKickers === false ? { autoKickers: false } : {}),
  };
  try {
    const replay = await simulateMapTest(mapDef, participants, () => {});
    res.set('Content-Type', 'application/json');
    res.set('Content-Encoding', 'gzip');
    res.send(zlibMod.gzipSync(Buffer.from(JSON.stringify(replay))));
  } catch (err) {
    console.error('맵 테스트 시뮬 실패:', err);
    res.status(500).json({ ok: false, error: '시뮬레이션에 실패했습니다.' });
  }
});

// 전체 순위 (누적 전적 리더보드, 공개)
app.get('/api/leaderboard', (_req, res) => {
  res.json({
    leaderboard: rooms.stats.list(),
    season: rooms.stats.season,
    hallOfFame: rooms.stats.hallOfFame,
  });
});

// 시즌 리셋 (관리자 전용) — 현재 상위권을 명예의 기록으로 보관하고 집계 초기화
app.post('/api/admin/leaderboard/reset', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(rooms.stats.reset());
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
