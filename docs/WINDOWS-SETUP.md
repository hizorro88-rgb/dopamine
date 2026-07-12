# 🪟 윈도우 데스크탑 서버 구축 가이드 (처음부터 끝까지)

집에 항상 켜져 있는 윈도우 PC로 **DOPAMINE — 인생을 건 핀볼**을 직접 서비스하는 전체 과정입니다.
소스코드 받기 → 서버 실행 → 도메인 연결 → 24시간 운영까지 순서대로 따라 하면 됩니다.

> 예상 소요 시간: 서버 실행까지 15분, 도메인 연결까지 +30분 (도메인 구매 별도)

---

## 준비물

| 항목 | 필요 여부 | 비고 |
|------|-----------|------|
| 윈도우 10/11 PC | 필수 | 항상 켜둘 수 있어야 함 |
| 인터넷 연결 | 필수 | 포트포워딩·고정IP 필요 없음 |
| 도메인 (예: `내이름.com`) | 도메인 연결 시 | 연 1~2만원, 5단계에서 구매 |

---

## 1단계. 소스코드 받기

**방법 A — ZIP 다운로드 (가장 쉬움)**

1. 브라우저에서 저장소 페이지 접속: `https://github.com/hizorro88-rgb/dopamine`
2. 초록색 **Code** 버튼 → **Download ZIP**
3. 다운로드한 ZIP을 원하는 위치에 압축 해제 (예: `C:\dopamine`)
   - 이후 이 문서에서는 `C:\dopamine` 기준으로 설명합니다

**방법 B — Git (업데이트 받기 편함)**

```powershell
winget install Git.Git        # git 설치 (PowerShell)
git clone https://github.com/hizorro88-rgb/dopamine.git C:\dopamine
```
> 나중에 업데이트할 때는 `C:\dopamine` 에서 `git pull` 한 줄이면 됩니다.

---

## 2단계. Node.js 설치

1. https://nodejs.org 접속 → **LTS** 버튼(초록색) 클릭해 설치 파일 다운로드
2. 설치 프로그램 실행 → 전부 기본값으로 **다음** → 설치 완료
   - 또는 PowerShell에서: `winget install OpenJS.NodeJS.LTS`
3. **PowerShell을 새로 열고** 확인:
   ```powershell
   node -v      # v18 이상 숫자가 나오면 성공 (예: v20.11.0)
   ```
   > `node`를 찾을 수 없다고 나오면: PowerShell 창을 닫고 새로 열기 (그래도 안 되면 PC 재시작)

---

## 3단계. 서버 실행

1. 게임 폴더에서 PowerShell 열기: 탐색기로 `C:\dopamine` 이동 → 주소창에 `powershell` 입력 후 Enter
2. 의존성 설치 (최초 1회만):
   ```powershell
   npm install
   ```
3. 설정 파일 수정: `C:\dopamine\scripts\start.bat` 을 **메모장으로 열어** 위쪽 값 수정
   ```bat
   set PORT=3000
   set DONATION_URL=https://qr.kakaopay.com/Ej8euQo2R   ← 카카오페이 후원 링크 (이미 설정됨, 끄려면 off)
   set ADMIN_KEY=나만아는비밀키123                       ← 반드시 바꾸세요! 후원자 등록 권한
   ```
4. **`scripts\start.bat` 더블클릭** → 검은 창에 "서버 시작 중..." 이 나오면 실행 성공
5. 브라우저에서 `http://localhost:3000` 접속 → DOPAMINE 홈 화면이 보이면 완료 🎉
   - 같은 와이파이의 폰에서도 `http://PC내부IP:3000` 으로 접속됩니다
     (내부 IP 확인: PowerShell에서 `ipconfig` → IPv4 주소)

> ⚠️ 검은 창을 닫으면 서버가 꺼집니다. 24시간 운영은 8단계 참고.

---

## 4단계. (선택) 잠깐 외부에 공개해서 테스트

도메인 없이 지금 당장 친구와 테스트하고 싶다면:

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:3000
```

→ 잠시 후 `https://무작위이름.trycloudflare.com` 주소가 출력됩니다. 이 주소를 친구에게 보내면 바로 접속 가능.
(임시 주소라 재실행마다 바뀝니다. 고정 주소는 아래 도메인 연결로)

---

## 5단계. 도메인 구매

추천 순서:

1. **Cloudflare Registrar** (dash.cloudflare.com → 도메인 등록) — 원가 판매라 가장 저렴, 6단계와 자동 연동
2. **가비아 / 후이즈** — 한국어 지원, 카드 결제 편함
3. `.com` `.net` 연 1.5~2만원 / `.site` `.click` 등은 첫해 몇천원

> 게임 느낌 나는 `.gg` 도메인도 있습니다 (연 3~4만원)

---

## 6단계. Cloudflare에 도메인 등록

*(Cloudflare Registrar에서 구매했다면 이 단계는 자동 완료 — 7단계로)*

1. https://dash.cloudflare.com 가입 → **사이트 추가** → 내 도메인 입력 → **Free 플랜** 선택
2. Cloudflare가 알려주는 **네임서버 2개**를 복사
3. 도메인 구매처(가비아 등) 관리 페이지 → 네임서버 설정 → 복사한 값으로 변경
4. 적용까지 몇 분~몇 시간 대기 (Cloudflare 대시보드에 "활성" 표시되면 완료)

---

## 7단계. 터널 연결 (핵심!)

포트포워딩 없이 PC와 도메인을 잇는 단계입니다. PowerShell에서:

```powershell
# 1) cloudflared 설치 (4단계에서 했다면 생략)
winget install Cloudflare.cloudflared

# 2) Cloudflare 로그인 (브라우저가 열리면 내 도메인 선택 → 승인)
cloudflared tunnel login

# 3) 터널 만들기
cloudflared tunnel create pinball

# 4) 도메인과 터널 연결 (원하는 주소로 — 예: game.내도메인.com)
cloudflared tunnel route dns pinball game.내도메인.com
```

이후 실행은 **`scripts\start-tunnel.bat` 더블클릭** (또는 아래 명령):

```powershell
cloudflared tunnel run --url http://localhost:3000 pinball
```

✅ 이제 **`https://game.내도메인.com`** 으로 전 세계 어디서나 접속됩니다.
- HTTPS 자동 적용 (자물쇠 아이콘)
- 집 IP 노출 없음, 유동 IP 걱정 없음
- Socket.IO(웹소켓) 무료 지원

> 서버 창(start.bat)과 터널 창(start-tunnel.bat) **둘 다** 켜져 있어야 합니다.

---

## 8단계. 24시간 운영 설정

**절전 끄기 (필수)**
- 설정 → 시스템 → 전원 → 화면 및 절전 → "절전 모드 전환" **안 함**
- (화면 끄기는 켜둬도 됩니다)

**부팅하면 자동으로 서버 켜지게**

방법 A — 작업 스케줄러 (간단):
1. 시작 메뉴 → "작업 스케줄러" → **작업 만들기**
2. 트리거: "로그온할 때" / 동작: 프로그램 시작 → `C:\dopamine\scripts\start.bat`
3. 같은 방식으로 `start-tunnel.bat` 도 하나 더 등록

방법 B — 서비스 등록 (창 없이 백그라운드):
1. 터널: `%USERPROFILE%\.cloudflared\config.yml` 파일 생성:
   ```yaml
   tunnel: pinball
   credentials-file: C:\Users\내계정\.cloudflared\<터널UUID>.json
   ingress:
     - hostname: game.내도메인.com
       service: http://localhost:3000
     - service: http_status:404
   ```
   (`<터널UUID>.json`은 해당 폴더에 이미 생성되어 있는 파일명 그대로)
   관리자 PowerShell에서 `cloudflared service install`
2. 게임 서버: `npm i -g pm2 pm2-windows-startup` →
   ```powershell
   pm2 start C:\dopamine\server\index.js --name pinball
   pm2 save
   pm2-startup install
   ```

---

## 9단계. 운영 팁

- **후원자 등록** (후원 받았을 때):
  ```powershell
  curl.exe -X POST https://game.내도메인.com/api/admin/donors `
    -H "x-admin-key: 나만아는비밀키123" -H "Content-Type: application/json" `
    -d '{\"name\":\"홍길동\",\"amount\":10000}'
  ```
  → 응답의 `DN-XXXXXX` 코드를 후원자에게 전달
- **데이터 백업**: `C:\dopamine\data\` 폴더가 전부입니다 (유저 맵·후원자·전적·후기). 가끔 복사해두세요
- **업데이트**: git이면 `git pull` 후 `npm install` / ZIP이면 새로 받되 **data 폴더는 보존**
- **서버 재시작**: 검은 창 닫고 start.bat 다시 더블클릭 (pm2면 `pm2 restart pinball`)

---

## 문제 해결 (FAQ)

| 증상 | 해결 |
|------|------|
| `node` / `npm` 명령을 찾을 수 없음 | PowerShell 새로 열기 → 안 되면 PC 재시작 → 그래도 안 되면 Node.js 재설치 |
| `winget` 이 없다고 나옴 | Microsoft Store에서 "앱 설치 관리자" 설치, 또는 각 프로그램을 공식 사이트에서 직접 다운로드 (cloudflared: github.com/cloudflare/cloudflared/releases 의 `-windows-amd64.msi`) |
| start.bat 창이 바로 꺼짐 | 폴더에서 PowerShell 열고 `node server\index.js` 직접 실행 → 에러 메시지 확인 (대부분 `npm install` 누락) |
| 3000 포트 사용 중 | start.bat 의 `PORT=3000` 을 3001 등으로 변경 (터널 명령의 `--url` 도 같이) |
| `tunnel login` 브라우저가 안 열림 | 출력된 URL을 복사해 브라우저에 직접 붙여넣기 |
| 도메인 접속 안 됨 | ① 서버 창 켜져 있는지 ② 터널 창 켜져 있는지 ③ Cloudflare 대시보드에 도메인 "활성"인지 순서로 확인 |
| 친구는 되는데 폰(같은 와이파이)만 안 됨 | 공유기 AP 격리 기능 — 그냥 도메인 주소로 접속하면 됨 |
| 초대 링크 복사 버튼이 수동 안내로 뜸 | HTTP 접속일 때 정상 동작 (localhost/HTTPS 에서는 원클릭 복사) |

---

## 최종 체크리스트

- [ ] `http://localhost:3000` 접속됨
- [ ] `scripts\start.bat` 의 `ADMIN_KEY` 를 나만 아는 값으로 변경
- [ ] `https://game.내도메인.com` 접속됨 (자물쇠 표시)
- [ ] 절전 모드 "안 함"
- [ ] 부팅 시 자동 실행 등록 (서버 + 터널)
- [ ] 폰(LTE, 와이파이 끄고)에서 도메인 접속 테스트
- [ ] 친구 한 명과 방 만들기 → 게임 한 판

즐거운 운영 되세요. 공은 거짓말하지 않습니다. 🎱
