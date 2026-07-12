const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server);

const rooms = new RoomManager(io);
io.on('connection', (socket) => rooms.handleConnection(socket));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎱 핀볼 공뽑기 서버 실행 중: http://localhost:${PORT}`);
});
