# 🎱 핀볼 공뽑기 (Dopamine Pinball)

친구를 초대해서 함께 즐기는 **멀티플레이어 물리엔진 뽑기 레이스** 게임입니다.
각자 공 하나를 배정받고, 핀볼 보드 위에서 공이 떨어지며 먼저 골인하는 순서로 순위가 정해집니다.
게임 시작 시 **랜덤 아이템 2개**를 받아 상대를 방해하거나 내 공을 가속할 수 있습니다.

## 실행 방법

```bash
npm install
npm start
```

브라우저에서 `http://localhost:3000` 접속.

1. 닉네임 입력 후 **방 만들기**
2. **초대 링크 복사** 버튼으로 친구에게 링크 전달 (또는 6자리 초대 코드 공유)
3. 친구가 모이면 방장이 **게임 시작**
4. 3초 카운트다운 후 공이 떨어집니다. 아이템을 써서 1등으로 골인하세요!

## 아키텍처

| 구성 | 선택 | 이유 |
|------|------|------|
| 물리엔진 | [Matter.js](https://brm.io/matter-js/) | 웹 물리엔진 중 가장 가볍고(min+gzip ≈ 80KB) 서버/브라우저 양쪽에서 동작 |
| 실시간 통신 | Socket.IO | 방(room) 개념 내장, 재연결 처리 자동 |
| 동기화 | **서버 권위(server-authoritative)** | 물리 시뮬레이션은 서버에서만 실행(60Hz), 클라이언트는 좌표 스냅샷(30Hz)을 받아 보간 렌더링만 수행 |

서버 권위 방식을 쓰는 이유:
- 참가자 전원이 **완전히 동일한 결과**를 봅니다 (물리엔진은 기기마다 미세하게 달라질 수 있음 → 뽑기 게임에서 치명적)
- 클라이언트는 물리 연산을 하지 않아 **저사양 기기/모바일에서도 가볍게** 동작
- 아이템 효과(상대 공 멈추기 등)를 서버에서 검증하므로 치팅 방지

```
server/
  index.js   # Express + Socket.IO 부트스트랩
  rooms.js   # 방 생성/초대코드 입장/방장 승계/퇴장 처리
  game.js    # Matter.js 시뮬레이션 루프, 보드 생성, 순위 판정
  items.js   # ★ 아이템 레지스트리 (여기에 추가하면 끝)
public/
  index.html # 홈 / 대기실 / 게임 화면
  client.js  # 캔버스 렌더러(스냅샷 보간), 아이템 UI, 소켓 핸들러
  style.css
```

## 아이템 시스템

현재 아이템:

| 아이템 | 대상 | 효과 |
|--------|------|------|
| 👻 유령 낙하 | 나 | 3초간 핀과 다른 공을 무시하고 그대로 떨어짐 |
| 🧊 얼리기 | 상대 | 상대 공을 3초간 그 자리에 정지 |
| 🚀 로켓 부스트 | 나 | 공이 아래로 강하게 가속 |
| 🌪️ 돌풍 | 상대 | 상대 공을 위로 날려버림 |
| 🎈 풍선 | 상대 | 상대 공이 3초간 커지고 잘 튕겨서 제어 불능 |

### 새 아이템 추가하기

`server/items.js` 의 `ITEMS` 객체에 항목 하나만 추가하면 됩니다.
이름/이모지/설명/대상 선택 UI까지 클라이언트에 자동 반영되므로 **클라이언트 코드 수정이 필요 없습니다.**

```js
// server/items.js
magnet: {
  id: 'magnet',
  name: '자석',
  emoji: '🧲',
  desc: '3초간 내 공이 골인 지점으로 끌려갑니다.',
  target: 'self',        // 'self' = 내 공 | 'opponent' = 대상 선택 UI 표시
  duration: 3000,        // 0이면 즉발형
  apply(game, ball) {
    ball.plugin.magnet = true;   // 지속 효과는 game.js tick에서 활용 가능
  },
  expire(game, ball) {
    ball.plugin.magnet = false;
  },
},
```

- `apply(game, ball)` — 효과 시작. `Matter.Body.setVelocity` 등으로 물리 상태를 조작하거나 `ball.plugin` 에 플래그 저장
- `expire(game, ball)` — `duration` 경과 후 자동 호출되어 효과 해제
- 배정 개수는 `server/game.js` 의 `ITEMS_PER_PLAYER` 상수로 조절

## 게임 규칙 커스터마이징

`server/game.js` 상단 상수:

- `ITEMS_PER_PLAYER` — 인당 아이템 개수 (기본 2)
- `COUNTDOWN_MS` — 시작 카운트다운 (기본 3초)
- `GAME_TIMEOUT_MS` — 제한시간, 초과 시 현재 위치 순으로 순위 결정 (기본 120초)
- `MAX_PLAYERS` — `server/rooms.js`, 방 최대 인원 (기본 8)
