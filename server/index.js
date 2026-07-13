const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');
const { DonorStore } = require('./donors');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

const donors = new DonorStore();
const { VisitStore } = require('./visits');
const visits = new VisitStore();

// 방문 집계 (방문자 id 기준 하루 1회) + 현재 카운트 반환
app.post('/api/visit', (req, res) => {
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

// 후원자 등록 (관리자 전용) → 후원자 코드 발급
app.post('/api/admin/donors', (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key || req.get('x-admin-key') !== key) {
    return res.status(403).json({ ok: false, error: '관리자 키가 올바르지 않습니다.' });
  }
  res.json(donors.add(req.body || {}));
});

const server = http.createServer(app);
const io = new Server(server);

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎱 핀볼 공뽑기 서버 실행 중: http://localhost:${PORT}`);
});
