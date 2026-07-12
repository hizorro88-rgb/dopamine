const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// 클라이언트 설정: 후원 링크 등 (환경변수로 주입, 없으면 버튼 숨김)
// 예: DONATION_URL=https://toss.me/내아이디 npm start
app.get('/api/config', (_req, res) => {
  res.json({
    donationUrl: process.env.DONATION_URL || '',
    donationLabel: process.env.DONATION_LABEL || '☕ 서버비 후원하기',
  });
});

const server = http.createServer(app);
const io = new Server(server);

const rooms = new RoomManager(io);
io.on('connection', (socket) => rooms.handleConnection(socket));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎱 핀볼 공뽑기 서버 실행 중: http://localhost:${PORT}`);
});
