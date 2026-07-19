/* global io, PinballComponents */
(() => {
  const socket = io();
  const { WORLD, COMPONENTS, defaultProps, buildShapes, defaultFinish, clampFinish, FINISH } = PinballComponents;

  // 화면에 보이는 뷰포트 크기 (월드는 세로로 훨씬 길다 → 카메라가 따라감)
  const VIEW = { width: 600, height: 900 };
  // 배치 가능 영역 (maxY 는 맵 길이에 따라 달라짐)
  const EDIT_BOUNDS = { minX: 25, maxX: 575, minY: 130 };

  // ── 상태 ──────────────────────────────────────────────
  let myId = null;
  // 🔌 재접속용 영구 토큰 (소켓 id 와 분리 — 잠깐 끊겨도 같은 자리로 복귀)
  let clientToken = localStorage.getItem('pinball-token');
  if (!clientToken) {
    clientToken =
      (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
      `t${Date.now()}${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('pinball-token', clientToken);
  }
  let currentRoomCode = null; // 지금 속한 방 코드 (재접속 대상)
  let hadConnected = false; // 최초 연결 이후인가 (재연결 판별)
  let room = null; // room:update 페이로드
  let spectating = false; // 이 방에서 나는 관전자인가
  let game = null; // { board, players(Map), items, snapshots[], ... }
  let eventRoom = null; // event:update 페이로드
  let myParticipantId = null; // 이벤트 추첨에서 내 공 번호
  let autoJoinedEvent = false;
  let autoJoinedRoom = false;
  let lastRanking = null; // 방금 끝난 판의 전체 순위 (결과 화면의 "이번 판 순위"용)
  let lastRankingEvent = false;
  let lastRankingWinMode = 'first';
  const $ = (id) => document.getElementById(id);

  const urlEventCode = new URLSearchParams(location.search).get('event');

  const urlRoomCode = new URLSearchParams(location.search).get('room');

  socket.on('connect', () => {
    myId = socket.id;
    // 🔌 재연결: 이미 방에 속해 있었다면 같은 자리로 복귀 시도
    if (hadConnected && currentRoomCode) {
      socket.emit('room:resume', { code: currentRoomCode, token: clientToken }, (res) => {
        if (res && res.ok) {
          hideReconnecting();
          if (res.room) applyRoomUpdate(res.room);
          if (res.game) {
            // 게임 진행 중이었다면 스냅샷 상태를 이어받아 렌더 재개
            resumeGameFromPayload(res.game);
          }
        } else {
          // 유예 시간이 지나 자리가 사라졌으면 방을 떠난 것으로 처리
          currentRoomCode = null;
          hideReconnecting();
          leaveToHome(res && res.error ? res.error : '방으로 돌아갈 수 없어 홈으로 이동했어요.');
        }
      });
      hadConnected = true;
      return;
    }
    hadConnected = true;
    // 이벤트 초대 링크(?event=CODE)로 들어온 경우 자동 입장
    if (urlEventCode && !autoJoinedEvent) {
      autoJoinedEvent = true;
      joinEvent(urlEventCode.toUpperCase());
    }
    // 방 초대 링크/QR(?room=CODE)로 들어온 경우 버튼 없이 바로 입장 (빠른 진행)
    if (urlRoomCode && !autoJoinedRoom) {
      autoJoinedRoom = true;
      joinRoom(urlRoomCode.toUpperCase());
    }
  });

  // ── 방문자 카운터 (방문자 id 기준 하루 1회 집계) ──
  (() => {
    let vid = localStorage.getItem('pinball-vid');
    if (!vid) {
      vid = 'v' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      localStorage.setItem('pinball-vid', vid);
    }
    fetch('/api/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vid }),
    })
      .then((r) => r.json())
      .then(({ today, total }) => {
        $('visit-today').textContent = today.toLocaleString();
        $('visit-total').textContent = total.toLocaleString();
        $('visit-counter').classList.remove('hidden');
      })
      .catch(() => {});
  })();

  // ── 후원 링크 (서버 환경변수 DONATION_URL 설정 시에만 표시) ──
  // 카카오페이 송금 링크는 모바일 전용(PC 웹은 404) — PC에서는 QR 모달로 안내한다.
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  function showDonateQr(url) {
    const box = $('donate-qr-box');
    box.innerHTML = '';
    /* global qrcode */
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 3 });
    $('donate-qr-url').textContent = url;
    $('donate-qr-modal').classList.remove('hidden');
  }

  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => {
      if (!cfg.donationUrl) return;
      document.querySelectorAll('.donate-link').forEach((a) => {
        a.href = cfg.donationUrl;
        a.textContent = cfg.donationLabel;
        a.classList.remove('hidden');
        a.addEventListener('click', (e) => {
          if (isMobile) return; // 모바일: 링크 그대로 열림 (카카오페이 정상 동작)
          e.preventDefault(); // PC: 404 대신 QR 스캔 안내
          showDonateQr(cfg.donationUrl);
        });
      });
      document.querySelectorAll('.donate-hint').forEach((el) => el.classList.remove('hidden'));
    })
    .catch(() => {});

  $('btn-donate-qr-close').addEventListener('click', () =>
    $('donate-qr-modal').classList.add('hidden')
  );

  // ── 화면 전환 ─────────────────────────────────────────
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(`screen-${name}`).classList.add('active');
    editor.active = name === 'editor';
    if (editor.active) requestAnimationFrame(renderEditor);
    if (name === 'home') refreshRooms();
  }

  // ── 공용: 구성요소 도형 렌더러 ─────────────────────────
  // 서버가 내려준 shapes 를 그대로 그린다. 새 구성요소가 추가돼도 수정 불필요.
  // 네온 스타일: 도형 색 그대로 채우고 같은 색으로 은은한 글로우.
  // shadowBlur 는 프레임마다 그리기엔 너무 비싸므로(모바일 끊김의 주범)
  // 원형은 글로우를 미리 구운 스프라이트를 캐시해서 drawImage 로 찍는다.
  const glowSprites = new Map(); // 'color|r|glow' -> canvas
  function glowCircleSprite(color, r, glow) {
    const key = color + '|' + r + '|' + glow;
    let c = glowSprites.get(key);
    if (!c) {
      const pad = 16;
      const scale = 2; // 확대돼도 선명하도록 2배 해상도로 굽는다
      c = document.createElement('canvas');
      c.width = c.height = Math.ceil((r + pad) * 2 * scale);
      const g = c.getContext('2d');
      const cx = c.width / 2;
      g.shadowColor = glow;
      g.shadowBlur = 13 * scale;
      g.fillStyle = color;
      g.beginPath();
      g.arc(cx, cx, r * scale, 0, Math.PI * 2);
      g.fill();
      if (r >= 5) {
        g.shadowBlur = 0;
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.beginPath();
        g.arc(cx, cx, r * 0.45 * scale, 0, Math.PI * 2);
        g.fill();
      }
      glowSprites.set(key, c);
    }
    return c;
  }

  // flat=true(미니맵)면 글로우 생략. offX/offY 는 움직이는 벽의 실시간 위치 오프셋.
  function drawComponent(ctx, comp, angle, flat, offX, offY) {
    ctx.save();
    ctx.translate(comp.x + (offX || 0), comp.y + (offY || 0));
    if (angle) ctx.rotate(angle);
    for (const s of comp.shapes) {
      const color = s.fill || '#35e0ff';
      if (!flat) {
        ctx.shadowColor = s.glow || color;
        ctx.shadowBlur = 13;
      }
      // 미니맵(flat)에서는 어두운 도형 대신 글로우 색으로 — 폭탄이 빨간 점으로 보임
      ctx.fillStyle = flat ? s.glow || color : color;
      if (s.kind === 'circle') {
        if (!flat) {
          // 미리 구운 글로우 스프라이트로 — shadowBlur 실시간 렌더 대비 수십 배 빠름
          ctx.shadowBlur = 0;
          const sp = glowCircleSprite(color, s.r, s.glow || color);
          const size = sp.width / 2;
          ctx.drawImage(sp, s.x - size / 2, s.y - size / 2, size, size);
        } else {
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(s.angle || 0);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-s.w / 2, -s.h / 2, s.w, s.h, 4);
        else ctx.rect(-s.w / 2, -s.h / 2, s.w, s.h);
        ctx.fill();
        if (!flat && s.h >= 8) {
          // 막대 중심선을 밝혀 네온관 느낌
          ctx.shadowBlur = 0;
          ctx.fillStyle = 'rgba(255,255,255,0.30)';
          ctx.fillRect(-s.w / 2 + 2, -1, s.w - 4, 2);
        }
        ctx.restore();
      }
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  function drawGoal(ctx, goal) {
    // 체커 피니시 라인 — 레이싱의 격식
    const left = goal.x - goal.width / 2;
    const cols = 20;
    const sq = goal.width / cols;
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < cols; i++) {
        ctx.fillStyle =
          (i + r) % 2 === 0 ? 'rgba(212,175,55,0.28)' : 'rgba(12,12,16,0.65)';
        ctx.fillRect(left + i * sq, goal.y + 2 + r * sq, sq + 0.5, sq);
      }
    }
    // 네온 헤어라인 (골인선)
    ctx.save();
    ctx.shadowColor = '#35e0ff';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = 'rgba(53,224,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(left, goal.y);
    ctx.lineTo(left + goal.width, goal.y);
    ctx.stroke();
    // 은은한 접근 글로우
    ctx.shadowBlur = 0;
    const grad = ctx.createLinearGradient(0, goal.y - 60, 0, goal.y);
    grad.addColorStop(0, 'rgba(53,224,255,0)');
    grad.addColorStop(1, 'rgba(53,224,255,0.09)');
    ctx.fillStyle = grad;
    ctx.fillRect(left, goal.y - 60, goal.width, 60);
    ctx.shadowColor = '#35e0ff';
    ctx.shadowBlur = 10;
    ctx.fillStyle = 'rgba(235,250,255,0.92)';
    ctx.font = "13px 'Cinzel', serif";
    ctx.textAlign = 'center';
    ctx.fillText('F I N I S H', goal.x, goal.y - 10);
    ctx.restore();
  }

  /** 보드 장식: 좌우 네온 파이프 라인 + 깊이 눈금 */
  function drawBoardDecor(ctx, board) {
    const H = board.world.height;
    const W = board.world.width || WORLD.width;
    ctx.save();
    ctx.shadowColor = '#35e0ff';
    ctx.shadowBlur = 10;
    ctx.strokeStyle = 'rgba(233,237,244,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(1.5, 0);
    ctx.lineTo(1.5, H);
    ctx.moveTo(W - 1.5, 0);
    ctx.lineTo(W - 1.5, H);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(53,224,255,0.30)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    for (let y = 300; y < H - 120; y += 300) {
      ctx.fillRect(W - 14, y, 12, 1);
      ctx.fillText(String(y), W - 17, y + 3);
    }
  }

  /**
   * 미니맵 렌더러 (게임/에디터 공용)
   * 전체 월드를 축소해 구성요소·공·현재 화면 영역을 표시한다.
   */
  // 미니맵 정적 레이어 캐시: 고정 구성요소는 한 번만 그려두고 매 프레임 복사한다
  // (구성요소가 수백 개인 맵에서 매 프레임 전부 다시 그리면 모바일이 버벅인다)
  let miniStatic = null; // { canvas, key }

  function drawMinimap(
    mCanvas,
    { width = WORLD.width, height, components, balls, players, selfId, camY, elapsed, selected, hidden, hiddenV, explosions, dynamic }
  ) {
    const mctx = mCanvas.getContext('2d');
    const s = mCanvas.width / width;
    mctx.setTransform(s, 0, 0, s, 0, 0);
    mctx.clearRect(0, 0, width, height);

    // 골인 지점
    mctx.fillStyle = 'rgba(53,224,255,0.30)';
    mctx.fillRect(0, height - 70, width, 70);

    if (dynamic) {
      // 에디터: 구성요소가 계속 바뀌므로 캐시 없이 그대로 그린다
      for (let i = 0; i < components.length; i++) {
        const comp = components[i];
        drawComponent(mctx, comp, comp.spin ? comp.spin * elapsed : 0, true);
      }
    } else {
      // 게임: 회전하지 않는 구성요소는 정적 레이어로 캐시 (숨김 상태가 바뀌면 갱신)
      // 숨김 집합 직렬화(정렬+join) 대신 버전 정수로 캐시 무효화 — 매 프레임 할당 제거
      const key =
        mCanvas.width + ':' + height + ':' + components.length + ':' + (hiddenV || 0);
      if (!miniStatic || miniStatic.key !== key) {
        const cache = document.createElement('canvas');
        cache.width = mCanvas.width;
        cache.height = mCanvas.height;
        const cctx = cache.getContext('2d');
        cctx.setTransform(s, 0, 0, s, 0, 0);
        for (let i = 0; i < components.length; i++) {
          if (hidden && hidden.has(i)) continue;
          const comp = components[i];
          if (comp.spin) continue; // 회전체는 매 프레임 실시간으로
          drawComponent(cctx, comp, 0, true);
        }
        miniStatic = { canvas: cache, key };
      }
      mctx.save();
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.drawImage(miniStatic.canvas, 0, 0);
      mctx.restore();
      // 회전체만 실시간
      for (let i = 0; i < components.length; i++) {
        const comp = components[i];
        if (!comp.spin) continue;
        if (hidden && hidden.has(i)) continue;
        drawComponent(mctx, comp, comp.spin * elapsed, true);
      }
    }

    // 폭발 표시
    if (explosions) {
      const nowMs = performance.now();
      for (const ex of explosions) {
        const t = (nowMs - ex.start) / 600;
        if (t >= 1) continue;
        mctx.globalAlpha = 1 - t;
        mctx.fillStyle = ex.color || '#ffb03a';
        mctx.beginPath();
        mctx.arc(ex.x, ex.y, ex.radius * 0.6, 0, Math.PI * 2);
        mctx.fill();
        mctx.globalAlpha = 1;
      }
    }

    // 선택된 구성요소 강조 (에디터)
    if (selected) {
      mctx.strokeStyle = '#d4af37';
      mctx.lineWidth = 12;
      mctx.beginPath();
      mctx.arc(selected.x, selected.y, 44, 0, Math.PI * 2);
      mctx.stroke();
    }

    // 공 (미니맵에서 보이도록 확대) — 색·본인 여부는 여기서 해석(매 프레임 배열 생성 제거)
    if (balls) {
      for (const b of balls) {
        const mine = players ? b.p === selfId : b.mine;
        const p = players ? players.get(b.p) : null;
        mctx.beginPath();
        mctx.arc(b.x, b.y, mine ? 34 : 26, 0, Math.PI * 2);
        mctx.fillStyle = players ? (p ? p.color : '#888') : b.color;
        mctx.fill();
        if (mine) {
          mctx.strokeStyle = '#ffffff';
          mctx.lineWidth = 10;
          mctx.stroke();
        }
      }
    }

    // 현재 화면 영역
    mctx.strokeStyle = 'rgba(255,255,255,0.75)';
    mctx.lineWidth = 10;
    mctx.strokeRect(5, camY + 5, width - 10, VIEW.height - 10);
  }

  /** 미니맵 캔버스 해상도 + 화면 크기를 맵 폭·길이 비율에 맞춤 */
  function setupMinimapCanvas(mCanvas, mapH, mapW = WORLD.width) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = 90; // CSS 픽셀 기준 내부 해상도
    mCanvas.width = w * dpr;
    mCanvas.height = w * (mapH / mapW) * dpr;

    // 표시 크기: 세로는 보드의 절반 정도, 짧은 맵은 가로가 너무 커지지 않게 제한
    const wrap = mCanvas.parentElement;
    const wrapH = wrap.clientHeight || 780;
    const wrapW = wrap.clientWidth || 520;
    let h = wrapH * 0.5;
    let cssW = h * (mapW / mapH);
    const maxW = wrapW * 0.2;
    if (cssW > maxW) {
      cssW = maxW;
      h = cssW * (mapH / mapW);
    }
    mCanvas.style.width = cssW + 'px';
    mCanvas.style.height = h + 'px';
  }

  const clampCam = (y, mapH) => Math.min(Math.max(y, 0), Math.max(mapH - VIEW.height, 0));

  // ── 홈: 방 만들기 / 참여 ──────────────────────────────
  const inputName = $('input-name');
  const inputCode = $('input-code');
  const homeError = $('home-error');

  // 초대 링크(?room=CODE)로 들어온 경우 코드 자동 입력
  const urlCode = new URLSearchParams(location.search).get('room');
  if (urlCode) inputCode.value = urlCode.toUpperCase();

  // ── 🎲 랜덤 닉네임 ──
  // 수백 명이 동시에 참가해도 왠만하면 겹치지 않도록: 어휘 풀을 크게 늘리고
  // 여러 "형태(템플릿)"를 섞어서 조합 수를 크게 키운다. (숫자 접미사는 쓰지 않음)
  const NAME_ADJ = [
    '전설의', '황금', '불꽃', '광란의', '무적', '최후의', '폭주', '은하', '벼락', '진격의',
    '강철', '초신성', '심연의', '질주하는', '광속', '백발백중', '운명의', '콰광', '대박', '미친',
    '침착한', '수상한', '전직', '자칭', '떠오르는', '전설급', '빛나는', '어둠의', '고독한', '방랑하는',
    '불멸의', '태초의', '심해의', '천상의', '지하의', '폭풍의', '한밤의', '새벽의', '황혼의', '얼어붙은',
    '작열하는', '춤추는', '노련한', '무명의', '은둔한', '해적', '용맹한', '교활한', '거대한', '초월의',
    '천둥의', '서릿발', '만렙', '금수저', '비밀의', '떠도는', '숨은', '반짝이는', '광폭한', '냉혹한',
  ];
  const NAME_NOUN = [
    '핀볼러', '도파민', '잭팟', '구슬왕', '승부사', '룰렛', '한탕', '갬블러', '폭탄', '유령',
    '회오리', '스나이퍼', '폭격기', '불사조', '타짜', '큰손', '한방', '용', '늑대', '여우',
    '요정', '기계', '전사', '점쟁이', '술래', '마술사', '검객', '해적왕', '연금술사', '사냥꾼',
    '방랑자', '기사', '도박꾼', '카우보이', '닌자', '사무라이', '광부', '탐험가', '기관사', '조련사',
    '마도사', '주술사', '표범', '독수리', '상어', '코뿔소', '무당벌레', '두더지', '햄스터', '수달',
    '고래', '펭귄', '알파카', '너구리', '까마귀', '올빼미', '살쾡이', '치타', '나침반', '유성',
  ];
  const NAME_TITLE = [
    '대장', '장인', '고수', '달인', '제왕', '요원', '마스터', '전설', 'king', '챔피언',
    '보스', '히어로', '킬러', '천재', '괴물', '레전드', '에이스', '지배자', '수호자', '개척자',
    '해결사', '스타', '거장', '패왕',
  ];
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  function pick2(arr) {
    // 서로 다른 두 원소를 뽑는다
    const a = pick(arr);
    let b = pick(arr);
    for (let i = 0; i < 4 && b === a; i++) b = pick(arr);
    return [a, b];
  }
  const NAME_TEMPLATES = [
    () => `${pick(NAME_ADJ)} ${pick(NAME_NOUN)}`,
    () => `${pick(NAME_NOUN)} ${pick(NAME_TITLE)}`,
    () => `${pick(NAME_ADJ)} ${pick(NAME_TITLE)}`,
    () => {
      const [a, b] = pick2(NAME_NOUN);
      return `${a}의 ${b}`;
    },
    () => `${pick(NAME_ADJ)}${pick(NAME_NOUN)}`,
    () => `${pick(NAME_ADJ)} ${pick(NAME_NOUN)} ${pick(NAME_TITLE)}`,
    () => {
      const [a, b] = pick2(NAME_NOUN);
      return `${pick(NAME_ADJ)} ${a}의 ${b}`;
    },
  ];
  function randomName() {
    let name = pick(NAME_TEMPLATES)();
    if (name.length > 12) name = `${pick(NAME_ADJ)} ${pick(NAME_NOUN)}`; // 12자 초과 시 짧은 형태로
    return name.slice(0, 12); // maxlength 안전
  }

  // 닉네임은 "탭마다" 다르게 정한다 (sessionStorage) — 같은 사람이 여러 창을 열어도 겹치지 않게.
  //  · sessionStorage: 이 탭이 정한 이름 (새로고침해도 유지, 다른 탭과는 분리)
  //  · localStorage 'pinball-name-manual': 사용자가 직접 입력한 이름만 기억 (다음 방문에 이어씀)
  //  · 그 외에는 탭마다 새 랜덤 이름
  function initialName() {
    return (
      sessionStorage.getItem('pinball-name') ||
      localStorage.getItem('pinball-name-manual') ||
      randomName()
    );
  }
  inputName.value = initialName();
  sessionStorage.setItem('pinball-name', inputName.value);

  // 사용자가 직접 입력하면 그 이름을 이 탭 + 다음 방문용으로 기억
  inputName.addEventListener('input', () => {
    sessionStorage.setItem('pinball-name', inputName.value);
    localStorage.setItem('pinball-name-manual', inputName.value.trim());
  });

  $('btn-random-name').addEventListener('click', () => {
    inputName.value = randomName();
    sessionStorage.setItem('pinball-name', inputName.value); // 랜덤은 이 탭에만 (localStorage 에 안 남김)
    updateJoinReady();
    // 아이콘 회전 연출 (재클릭해도 다시 재생되도록 리셋)
    const b = $('btn-random-name');
    b.classList.remove('spinning');
    void b.offsetWidth;
    b.classList.add('spinning');
  });

  function myName() {
    const name = inputName.value.trim() || '플레이어';
    sessionStorage.setItem('pinball-name', name);
    return name;
  }

  // ── 후원자 코드 ──
  const inputDonorCode = $('input-donor-code');
  inputDonorCode.value = localStorage.getItem('pinball-donor-code') || '';

  function myDonorCode() {
    return inputDonorCode.value.trim().toUpperCase();
  }

  $('btn-donor-toggle').addEventListener('click', () => {
    $('donor-box').classList.toggle('hidden');
    if (!$('donor-box').classList.contains('hidden')) checkDonorCode();
  });

  function checkDonorCode() {
    const code = myDonorCode();
    const status = $('donor-status');
    if (!code) {
      status.textContent = '후원 후 받은 코드를 입력하면 이름에 💖 배지가 표시됩니다!';
      status.classList.remove('ok');
      return;
    }
    socket.emit('donor:check', { code }, (res) => {
      if (res.ok) {
        localStorage.setItem('pinball-donor-code', code);
        status.textContent = `💖 ${res.name}님, 후원 감사합니다! 혜택이 적용됩니다.`;
        status.classList.add('ok');
      } else {
        status.textContent = '유효하지 않은 코드입니다.';
        status.classList.remove('ok');
      }
    });
  }
  inputDonorCode.addEventListener('change', checkDonorCode);
  // 저장된 코드가 있으면 입력창을 미리 열어 확인 표시
  if (inputDonorCode.value) {
    $('donor-box').classList.remove('hidden');
    socket.on('connect', checkDonorCode);
  }

  // ── 전체 순위 (누적 전적 리더보드) ──
  function openLeaderboard() {
    fetch('/api/leaderboard')
      .then((r) => r.json())
      .then(({ leaderboard, season, hallOfFame }) => {
        const seasonTag = season > 1 ? ` · 시즌 ${season}` : '';
        $('board-title').textContent = `📊 전체 순위 (누적 전적)${seasonTag}`;
        $('board-hint').innerHTML =
          '모든 게임의 결과가 닉네임 기준으로 누적됩니다.<br>점수 = 참가자 수 − 순위 + 1 (2인 이상 게임만 집계)';
        const list = $('board-list');
        list.innerHTML = '';
        if (!leaderboard.length) {
          list.innerHTML =
            '<li class="board-empty">아직 기록이 없어요. 첫 게임을 시작해보세요! (2인 이상 게임만 집계)</li>';
        }
        const rankEmoji = ['🥇', '🥈', '🥉'];
        for (const e of leaderboard) {
          const li = document.createElement('li');
          li.innerHTML = `<span class="hall-rank">${rankEmoji[e.rank - 1] || e.rank}</span>
            <span>${escapeHtml(e.name)}</span>
            <span class="board-stats">
              <span class="board-points">${e.points}점</span><br>
              ${e.wins}승 / ${e.plays}판
            </span>`;
          list.appendChild(li);
        }
        // 🏆 지난 시즌 명예의 전당 (있으면 하단에 접어서)
        if (Array.isArray(hallOfFame) && hallOfFame.length) {
          const hof = document.createElement('li');
          hof.className = 'board-hof';
          const seasons = hallOfFame
            .map((h) => {
              const top = h.standings
                .slice(0, 3)
                .map((s, i) => `${rankEmoji[i] || ''}${escapeHtml(s.name)}`)
                .join(' · ');
              return `<div class="hof-row"><b>시즌 ${h.season}</b> ${top || '기록 없음'}</div>`;
            })
            .join('');
          hof.innerHTML = `<div class="hof-title">🏆 지난 시즌 명예의 전당</div>${seasons}`;
          list.appendChild(hof);
        }
        $('board-modal').classList.remove('hidden');
      })
      .catch(() => {});
  }

  // ── 이번 판 순위 (방금 끝난 게임의 전체 순위) ──
  function openRoundRanking() {
    const ranking = lastRanking || [];
    const mineKey = lastRankingEvent ? myParticipantId : myId;
    $('board-title').textContent = '🏁 이번 판 순위';
    $('board-hint').innerHTML = lastRankingWinMode === 'last'
      ? '🐢 늦게 골인 당첨 — 늦게 도착할수록 높은 순위'
      : '🥇 먼저 골인 우승 — 먼저 도착한 순서';
    const list = $('board-list');
    list.innerHTML = '';
    if (!ranking.length) {
      list.innerHTML = '<li class="board-empty">순위 기록이 없어요.</li>';
    }
    const rankEmoji = ['🥇', '🥈', '🥉'];
    for (const r of ranking) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="hall-rank">${rankEmoji[r.rank - 1] || r.rank}</span>
        <span class="player-dot" style="background:${r.color || '#888'}"></span>
        <span>${escapeHtml(r.name)}${r.playerId === mineKey ? ' (나)' : ''}</span>
        <span class="board-stats">${r.finished ? formatTime(r.timeMs) : '미도착'}</span>`;
      list.appendChild(li);
    }
    $('board-modal').classList.remove('hidden');
  }

  $('btn-board').addEventListener('click', openLeaderboard);
  // 게임 결과 화면의 버튼은 "방금 끝난 판의 전체 순위"를 보여준다
  $('btn-board-result').addEventListener('click', openRoundRanking);
  $('btn-board-close').addEventListener('click', () => $('board-modal').classList.add('hidden'));

  // ── 🔧 관리자 (숨은 경로 /dopaman 로만 진입) ──
  let adminKey = ''; // 세션 메모리에만 보관
  const adminHeaders = () => ({ 'x-admin-key': adminKey, 'Content-Type': 'application/json' });
  const SETTING_KEYS = ['donationUrl', 'donationLabel', 'timeScale', 'itemIntroMs', 'shuffleAutoDropMs', 'mapDailyLimit'];

  // /dopaman/pinball 접속 여부 — true면 관리자 전용 모드 (게임 UI를 아예 띄우지 않음)
  const ADMIN_MODE = /\/dopaman(\/pinball)?\/?$/.test(location.pathname);

  function openAdmin() {
    $('admin-msg').textContent = '';
    $('admin-panel').classList.add('hidden');
    $('admin-login').classList.remove('hidden');
    $('admin-key').value = adminKey;
    showScreen('admin');
    $('admin-key').focus();
  }
  // /dopaman/pinball 진입 시 관리자 페이지 자동 오픈은 스크립트 맨 끝에서 호출한다.
  // (openAdmin → showScreen 이 아래쪽에 const 로 선언된 editor 를 건드리므로,
  //  여기서 바로 부르면 TDZ ReferenceError 로 이후 핸들러 등록이 전부 중단된다)

  $('btn-admin-open').addEventListener('click', () => {
    adminKey = $('admin-key').value;
    loadAdmin();
  });
  $('admin-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { adminKey = $('admin-key').value; loadAdmin(); }
  });

  // 로그인 성공 시 설정 + 맵을 함께 불러온다
  function loadAdmin() {
    $('admin-msg').textContent = '';
    if (!adminKey.trim()) return ($('admin-msg').textContent = '관리자 키를 입력해주세요.');
    $('admin-msg').textContent = '확인 중…';
    fetch('/api/admin/settings', { headers: adminHeaders() })
      .then(async (r) => {
        if (r.ok) return r.json();
        // 서버가 준 사유(키 미설정/오류 등)를 그대로 보여준다
        let msg = '관리자 키가 올바르지 않습니다.';
        try {
          const j = await r.json();
          if (j && j.error) msg = j.error;
        } catch {
          /* 본문 없음 */
        }
        throw new Error(msg);
      })
      .then(({ settings }) => {
        $('admin-msg').textContent = ''; // '확인 중…' 지우기
        $('admin-login').classList.add('hidden');
        $('admin-panel').classList.remove('hidden');
        for (const k of SETTING_KEYS) {
          const el = $('set-' + k);
          if (el) el.value = settings[k] != null ? settings[k] : '';
        }
        loadAdminMaps();
        loadAdminFeedback();
        loadSeasonInfo();
      })
      .catch((e) => ($('admin-msg').textContent = e.message || '불러오기 실패'));
  }

  function loadAdminFeedback() {
    fetch('/api/admin/feedback', { headers: adminHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('불러오기 실패'))))
      .then(({ feedback }) => {
        $('admin-feedback-summary').textContent = feedback.length
          ? `총 ${feedback.length}건 (최신순)`
          : '아직 등록된 개선 요청이 없어요.';
        const list = $('admin-feedback-list');
        list.innerHTML = '';
        for (const f of feedback) {
          const li = document.createElement('li');
          li.className = 'admin-fb-row';
          const when = f.at ? new Date(f.at).toLocaleString() : '';
          li.innerHTML = `<div class="admin-fb-head"><b>${escapeHtml(f.name || '익명')}</b> <span class="admin-fb-when">${when}</span></div>
            <div class="admin-fb-msg">${escapeHtml(f.message || '')}</div>`;
          list.appendChild(li);
        }
      })
      .catch(() => {});
  }

  $('btn-admin-save-settings').addEventListener('click', () => {
    const patch = {};
    for (const k of SETTING_KEYS) {
      const el = $('set-' + k);
      if (el) patch[k] = el.value;
    }
    fetch('/api/admin/settings', { method: 'POST', headers: adminHeaders(), body: JSON.stringify(patch) })
      .then((r) => r.json())
      .then((res) => {
        const msg = $('admin-settings-msg');
        if (!res.ok) { msg.style.color = 'var(--danger)'; return (msg.textContent = res.error || '저장 실패'); }
        msg.style.color = '#6fdfa0';
        msg.textContent = '✅ 저장했습니다. (즉시 적용)';
        for (const k of SETTING_KEYS) { const el = $('set-' + k); if (el) el.value = res.settings[k]; }
      })
      .catch(() => ($('admin-settings-msg').textContent = '저장 실패'));
  });

  // 🏆 시즌 리더보드 — 현재 시즌 표시 & 리셋
  function loadSeasonInfo() {
    fetch('/api/leaderboard')
      .then((r) => r.json())
      .then(({ season, leaderboard }) => {
        $('admin-season-info').textContent = `현재 시즌: ${season || 1} · 등록 ${leaderboard.length}명`;
      })
      .catch(() => {});
  }
  $('btn-admin-reset-season').addEventListener('click', () => {
    if (!confirm('현재 시즌을 마감하고 리더보드를 초기화할까요?\n상위 10명은 명예의 전당에 보관됩니다.')) return;
    const msg = $('admin-season-msg');
    fetch('/api/admin/leaderboard/reset', { method: 'POST', headers: adminHeaders() })
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) { msg.style.color = 'var(--danger)'; return (msg.textContent = res.error || '리셋 실패'); }
        msg.style.color = '#6fdfa0';
        msg.textContent = `✅ 시즌 ${res.season} 시작! 리더보드를 초기화했어요.`;
        loadSeasonInfo();
      })
      .catch(() => { msg.style.color = 'var(--danger)'; msg.textContent = '리셋 실패'; });
  });

  function loadAdminMaps() {
    fetch('/api/admin/maps', { headers: adminHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('관리자 키가 올바르지 않습니다.'))))
      .then(({ maps }) => {
        const nCustom = maps.filter((m) => !m.builtin).length;
        $('admin-summary').textContent = `기본 맵 ${maps.length - nCustom}개 · 유저 맵 ${nCustom}개 (기본 맵은 편집만 가능)`;
        const list = $('admin-map-list');
        list.innerHTML = '';
        for (const m of maps) {
          const li = document.createElement('li');
          li.className = 'admin-map-row';
          const when = m.builtin ? (m.overridden ? '편집됨' : '기본 맵') : m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '';
          const badge = m.builtin ? '<span class="admin-badge">기본</span>' : '';
          // 유저 맵 → 삭제 / 기본 맵 → 편집됨이면 기본값 복원, 아니면 편집만
          const rightBtn = m.builtin
            ? m.overridden
              ? `<button class="btn small danger-btn" data-revert="${m.id}" data-name="${escapeHtml(m.name)}">↩ 기본값</button>`
              : ''
            : `<button class="btn small danger-btn" data-del="${m.id}" data-name="${escapeHtml(m.name)}">🗑 삭제</button>`;
          li.innerHTML = `<div class="admin-map-info">
              <span class="admin-map-name">${badge}${escapeHtml(m.name)}</span>
              <span class="admin-map-meta">${escapeHtml(m.author)} · ${m.count}개 · 길이 ${m.height} · ${when}</span>
            </div>
            <div class="admin-map-actions">
              <button class="btn small" data-edit="${m.id}">✏️ 편집</button>
              ${rightBtn}
            </div>`;
          list.appendChild(li);
        }
        list.querySelectorAll('[data-del]').forEach((b) =>
          b.addEventListener('click', () => adminDeleteMap(b.dataset.del, b.dataset.name, false))
        );
        list.querySelectorAll('[data-revert]').forEach((b) =>
          b.addEventListener('click', () => adminDeleteMap(b.dataset.revert, b.dataset.name, true))
        );
        list.querySelectorAll('[data-edit]').forEach((b) =>
          b.addEventListener('click', () => adminEditMap(b.dataset.edit))
        );
      })
      .catch((e) => {
        $('admin-msg').textContent = e.message || '불러오기 실패';
      });
  }

  function adminDeleteMap(id, name, revert) {
    const q = revert
      ? `「${name}」을(를) 기본값으로 되돌릴까요? (편집 내용이 사라집니다)`
      : `「${name}」 맵을 삭제할까요? 되돌릴 수 없습니다.`;
    if (!confirm(q)) return;
    fetch('/api/admin/maps/delete', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ id }) })
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) return ($('admin-msg').textContent = res.error || (revert ? '복원 실패' : '삭제 실패'));
        loadAdminMaps();
      })
      .catch(() => ($('admin-msg').textContent = revert ? '복원 실패' : '삭제 실패'));
  }

  function adminEditMap(id) {
    // 맵을 에디터로 불러와 재편집 → 저장 시 관리자 API로 덮어쓰기
    socket.emit('maps:get', { mapId: id }, (res) => {
      if (!res || !res.ok) return ($('admin-msg').textContent = '맵을 불러올 수 없습니다.');
      openEditor({ from: 'admin', map: res.map, adminEditId: id, adminEditName: res.map.name });
    });
  }

  // ── 명예의 전당 ──
  $('btn-hall').addEventListener('click', () => {
    fetch('/api/donors')
      .then((r) => r.json())
      .then(({ donors }) => {
        const list = $('hall-list');
        list.innerHTML = '';
        if (!donors.length) {
          list.innerHTML = '<li class="hall-empty">아직 후원자가 없어요. 첫 번째 후원자가 되어주세요!</li>';
        }
        const rankEmoji = ['👑', '🥈', '🥉'];
        donors.forEach((d, i) => {
          const li = document.createElement('li');
          li.innerHTML = `<span class="hall-rank">${rankEmoji[i] || i + 1}</span>
            <span>💖 ${escapeHtml(d.name)}</span>
            <span class="hall-amount">${d.amount > 0 ? d.amount.toLocaleString() + '원' : ''}</span>`;
          list.appendChild(li);
        });
        $('hall-modal').classList.remove('hidden');
      })
      .catch(() => {});
  });
  $('btn-hall-close').addEventListener('click', () => $('hall-modal').classList.add('hidden'));

  // ── 🎁 아이템 도감 (누구나 열람) ── 등급 체계: 일반·희귀·영웅·전설·신화·유일
  const GRADE_ORDER = ['common', 'rare', 'hero', 'legend', 'mythic', 'unique'];
  const GRADE_META = {
    common: { label: '일반' },
    rare: { label: '희귀' },
    hero: { label: '영웅' },
    legend: { label: '전설' },
    mythic: { label: '신화' },
    unique: { label: '유일' },
  };
  const gradeLabel = (g) => (GRADE_META[g] ? GRADE_META[g].label : g);
  let itemsCache = null;
  function renderItemsGuide(items) {
    const list = $('items-list');
    list.innerHTML = '';
    // 낮은 등급 → 높은 등급 순으로 정렬
    const sorted = [...items].sort(
      (a, b) => (GRADE_ORDER.indexOf(a.grade) + 100) % 100 - ((GRADE_ORDER.indexOf(b.grade) + 100) % 100)
    );
    for (const it of sorted) {
      const target = it.target === 'self' ? '내 공' : '상대 공';
      const dur = it.duration > 0 ? `${Math.round(it.duration / 1000)}초` : '즉시';
      const li = document.createElement('li');
      li.className = `item-guide-row gcard gcard-${it.grade}`;
      li.innerHTML = `<span class="item-guide-emoji">${it.emoji}</span>
        <div class="item-guide-body">
          <div class="item-guide-head"><b>${escapeHtml(it.name)}</b>
            <span class="grade-badge grade-${it.grade}">${gradeLabel(it.grade)}</span>
            <span class="item-guide-meta">${target} · ${dur}</span>
            ${chanceTag(it)}
          </div>
          <div class="item-guide-desc">${escapeHtml(it.desc)}</div>
        </div>`;
      list.appendChild(li);
    }
  }
  /** 등장 확률 배지 — 일반 뽑기(뽑을 때 확률) / 특별 지급(한 판 등장 확률) 구분 */
  function chanceTag(it) {
    if (typeof it.chance !== 'number') return '';
    const pct = it.chance * 100;
    const txt = pct >= 10 ? pct.toFixed(0) : pct.toFixed(1);
    const isSpecial = it.kind === 'special';
    const label = isSpecial ? '특별 등장' : '뽑기 확률';
    return `<span class="chance-tag${isSpecial ? ' chance-special' : ''}" title="${
      isSpecial ? '뽑기 풀에서 제외 — 한 판당 이 아이템이 등장할 확률' : '아이템 한 칸을 뽑을 때 이 아이템이 나올 확률'
    }">${label} ${txt}%</span>`;
  }
  function openItemsGuide() {
    $('items-modal').classList.remove('hidden');
    if (itemsCache) return renderItemsGuide(itemsCache);
    $('items-list').innerHTML = '<li class="hint" style="text-align:center">불러오는 중…</li>';
    fetch('/api/items')
      .then((r) => r.json())
      .then(({ items }) => {
        itemsCache = items || [];
        renderItemsGuide(itemsCache);
      })
      .catch(() => ($('items-list').innerHTML = '<li class="error">불러오기 실패</li>'));
  }
  // 🎁 아이템전 버튼 옆의 ⓘ 인포 버튼(들) → 아이템 도감 열기 (대기실에서 접근)
  document.querySelectorAll('.items-info-btn').forEach((b) => b.addEventListener('click', openItemsGuide));
  $('btn-items-close').addEventListener('click', () => $('items-modal').classList.add('hidden'));

  // ── ✍️ 개선 요청 / 개발자에게 한마디 ──
  $('btn-feedback').addEventListener('click', () => {
    $('feedback-msg').textContent = '';
    $('input-feedback-msg').value = '';
    $('input-feedback-name').value =
      sessionStorage.getItem('pinball-name') || localStorage.getItem('pinball-name-manual') || '';
    $('feedback-modal').classList.remove('hidden');
    $('input-feedback-msg').focus();
  });
  $('btn-feedback-close').addEventListener('click', () => $('feedback-modal').classList.add('hidden'));
  $('btn-feedback-submit').addEventListener('click', () => {
    const message = $('input-feedback-msg').value.trim();
    const name = $('input-feedback-name').value.trim();
    const msg = $('feedback-msg');
    if (!message) {
      msg.style.color = 'var(--danger)';
      return (msg.textContent = '내용을 입력해주세요.');
    }
    fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, name }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) {
          msg.style.color = 'var(--danger)';
          return (msg.textContent = res.error || '전송 실패');
        }
        msg.style.color = '#6fdfa0';
        msg.textContent = '✅ 소중한 의견 감사합니다! 개발자가 확인할게요.';
        $('input-feedback-msg').value = '';
        setTimeout(() => $('feedback-modal').classList.add('hidden'), 1200);
      })
      .catch(() => {
        msg.style.color = 'var(--danger)';
        msg.textContent = '전송 실패';
      });
  });

  // 방 세부 설정은 대기실에서 정한다. 방 만들기는 지난번 선택(로컬 저장)이나
  // 기본값으로 방을 열고, 방장이 대기실에서 우승조건·아이템·공개수·판수·맵을 조절한다.
  const roomDefaults = () => ({
    winMode: localStorage.getItem('pinball-winmode') === 'last' ? 'last' : 'first',
    itemsEnabled: localStorage.getItem('pinball-items') !== '0',
    ballsPerPlayer: Number(localStorage.getItem('pinball-balls')) || 1,
    rounds: Number(localStorage.getItem('pinball-rounds')) || 1,
  });

  $('btn-create').addEventListener('click', () => {
    const d = roomDefaults();
    socket.emit(
      'room:create',
      {
        name: myName(),
        donorCode: myDonorCode(),
        winMode: d.winMode,
        ballsPerPlayer: d.ballsPerPlayer,
        itemsEnabled: d.itemsEnabled,
        rounds: d.rounds,
        password: $('input-room-pw').value,
        token: clientToken,
      },
      (res) => {
        if (!res.ok) homeError.textContent = res.error || '방 생성 실패';
      }
    );
  });

  $('btn-join').addEventListener('click', joinRoom);
  inputCode.addEventListener('keydown', (e) => e.key === 'Enter' && joinRoom());

  // 초대 코드가 입력되면 입장 버튼이 금빛으로 고동친다
  function updateJoinReady() {
    $('btn-join').classList.toggle('ready', inputCode.value.trim().length > 0);
  }
  inputCode.addEventListener('input', updateJoinReady);
  updateJoinReady(); // 초대 링크(?room=)로 들어와 미리 채워진 경우

  function joinRoom(codeArg, password) {
    // 클릭 핸들러로도 직접 연결되므로 문자열일 때만 인자 사용
    const code = (typeof codeArg === 'string' ? codeArg : inputCode.value).trim().toUpperCase();
    if (!code) return (homeError.textContent = '초대 코드를 입력해주세요.');
    socket.emit('room:join', { code, name: myName(), donorCode: myDonorCode(), password, token: clientToken }, (res) => {
      if (res.ok) {
        spectating = false;
        closeJoinPw();
        return;
      }
      // 🔒 비밀방이면 비밀번호 입력창을 띄운다 (관전은 별도 버튼으로 언제든 가능)
      if (res.locked) return openJoinPw(code, password ? res.error : '');
      homeError.textContent = res.error || '입장 실패';
    });
  }

  // ── 🔒 비밀방 입장: 비밀번호 모달 ──
  let pendingJoinCode = null;
  function openJoinPw(code, errMsg) {
    pendingJoinCode = code;
    $('join-pw-room').textContent = `${code} 방`;
    $('input-join-pw').value = '';
    $('join-pw-msg').textContent = errMsg || '';
    $('join-pw-modal').classList.remove('hidden');
    $('input-join-pw').focus();
  }
  function closeJoinPw() {
    pendingJoinCode = null;
    $('join-pw-modal').classList.add('hidden');
  }
  function submitJoinPw() {
    const pw = $('input-join-pw').value.trim();
    if (!pw) return ($('join-pw-msg').textContent = '비밀번호를 입력해주세요.');
    if (pendingJoinCode) joinRoom(pendingJoinCode, pw);
  }
  $('btn-join-pw').addEventListener('click', submitJoinPw);
  $('input-join-pw').addEventListener('keydown', (e) => e.key === 'Enter' && submitJoinPw());
  $('btn-join-pw-close').addEventListener('click', closeJoinPw);

  // ── 🔥 공개 방 목록 (누구나 입장·관전) ────────────────
  function refreshRooms() {
    if (!$('screen-home').classList.contains('active') || !socket.connected) return;
    socket.emit('rooms:list', null, (res) => {
      if (!res || !res.ok) return;
      const list = $('rooms-list');
      list.innerHTML = '';
      if (!res.rooms.length) {
        list.innerHTML = '<li class="rooms-empty">아직 열린 방이 없어요 — 첫 방을 만들어보세요!</li>';
        return;
      }
      for (const r of res.rooms) {
        const li = document.createElement('li');
        const playing = r.state === 'playing';
        const full = r.players >= r.maxPlayers;
        const spec = r.spectators > 0 ? ` · 👁 ${r.spectators}` : '';
        li.innerHTML = `<div>
            <div class="room-title">
              <span class="room-state ${playing ? 'playing' : ''}">${playing ? '🔴 게임중' : '🟢 대기중'}</span>
              ${r.locked ? '🔒 ' : ''}${escapeHtml(r.hostName)}의 방
            </div>
            <div class="room-meta">${escapeHtml(r.mapName)} · ${r.players}/${r.maxPlayers}명${spec} · ${r.winMode === 'last' ? '🐢 늦게' : '🥇 먼저'} 골인 · 공 ${r.ballsPerPlayer}개 · ${r.itemsEnabled === false ? '🚫 노템' : '🎁 아이템'}${r.rounds > 1 ? ` · 🔁 ${r.rounds}판` : ''}</div>
          </div>
          <div class="room-actions">
            ${!playing && !full ? `<button class="btn small" data-join="${r.code}">입장</button>` : ''}
            <button class="btn small" data-spectate="${r.code}">👁 관전</button>
          </div>`;
        list.appendChild(li);
      }
      list.querySelectorAll('[data-join]').forEach((btn) =>
        btn.addEventListener('click', () => joinRoom(btn.dataset.join))
      );
      list.querySelectorAll('[data-spectate]').forEach((btn) =>
        btn.addEventListener('click', () => spectateRoom(btn.dataset.spectate))
      );
    });
  }

  /** 관전 입장: 대기실이면 그대로 구경, 게임 중이면 경기 화면으로 바로 합류 */
  function spectateRoom(code) {
    socket.emit('room:spectate', { code }, (res) => {
      if (!res || !res.ok) return (homeError.textContent = res.error || '관전 입장 실패');
      spectating = true;
      if (res.game) startGameView(res.game); // 진행 중인 경기에 중간 합류
      // 대기실이면 곧바로 도착하는 room:update 가 대기실 화면을 띄운다
    });
  }

  $('btn-rooms-refresh').addEventListener('click', refreshRooms);
  setInterval(refreshRooms, 5000); // 홈 화면에서만 5초마다 자동 갱신
  socket.on('connect', refreshRooms);

  // ── 🎪 이벤트 추첨 ────────────────────────────────────
  $('btn-event-create').addEventListener('click', () => {
    socket.emit('event:create', {}, (res) => {
      if (!res.ok) return (homeError.textContent = res.error || '이벤트 생성 실패');
      eventRoom = { code: res.code, ...res };
      $('input-event-name').value = sessionStorage.getItem('pinball-name') || localStorage.getItem('pinball-name-manual') || randomName();
      renderEventScreen(eventRoom);
      showScreen('event');
    });
  });

  function joinEvent(code) {
    socket.emit('event:join', { code }, (res) => {
      if (!res.ok) return (homeError.textContent = res.error || '이벤트 입장 실패');
      eventRoom = res;
      myParticipantId = null;
      $('input-event-name').value = sessionStorage.getItem('pinball-name') || localStorage.getItem('pinball-name-manual') || randomName();
      $('event-my-status').textContent = '';
      renderEventScreen(res);
      showScreen('event');
      if (res.replay) beginReplay(res.replay); // 재생 중 늦게 합류 → 따라잡기
    });
  }

  socket.on('event:update', (ev) => {
    eventRoom = { ...eventRoom, ...ev };
    renderEventScreen(eventRoom);
  });

  function renderEventScreen(ev) {
    if (!ev || !ev.code) return;
    $('event-code').textContent = ev.code;
    // 가까이 있는 사람은 QR을 찍어서 바로 참가 (같은 코드면 다시 그리지 않음)
    const evQr = $('event-qr');
    if (evQr && evQr.dataset.code !== ev.code) {
      evQr.dataset.code = ev.code;
      try {
        /* global qrcode */
        const qr = qrcode(0, 'M');
        qr.addData(`${location.origin}${location.pathname}?event=${ev.code}`);
        qr.make();
        evQr.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
      } catch {
        if (evQr.parentElement) evQr.parentElement.style.display = 'none';
      }
    }
    $('event-participant-count').textContent = `참가 ${ev.participantCount || 0}/${ev.maxParticipants || 1000}명`;
    $('event-viewers').textContent = `시청 ${ev.viewers || 0}명`;

    const names = $('event-names');
    names.innerHTML = '';
    for (const n of ev.recent || []) {
      const chip = document.createElement('span');
      chip.className = 'name-chip';
      chip.textContent = n;
      names.appendChild(chip);
    }

    const isHost = ev.hostId === myId;
    const startBtn = $('btn-event-start');
    if (ev.state === 'lobby') {
      // 참가 행은 아직 등록 안 한 사람에게만 (방장도 원하면 참가 가능)
      $('event-register-row').style.display = myParticipantId == null ? '' : 'none';
      // 방장은 직접 참가하지 않아도 추첨을 시작할 수 있다. (참가자 수 부족은 서버가 안내)
      startBtn.disabled = !isHost;
      startBtn.textContent = isHost
        ? (ev.participantCount || 0) < 2
          ? '🎲 추첨 시작 (참가 2명 이상 필요)'
          : '🎲 추첨 시작'
        : '⏳ 호스트가 추첨을 시작하기를 기다리는 중';
      $('event-progress').classList.add('hidden');
    } else if (ev.state === 'simulating') {
      $('event-register-row').style.display = 'none';
      startBtn.disabled = true;
      startBtn.textContent = '🎬 녹화 중...';
      $('event-progress').classList.remove('hidden');
    } else {
      // playing: 재생 중이거나 종료
      $('event-register-row').style.display = 'none';
      startBtn.disabled = !isHost;
      startBtn.textContent = isHost ? '🔄 새 추첨 준비' : '재생 중';
    }

    // 맵 선택 (호스트 전용)
    socket.emit('maps:list', null, (res) => {
      if (!res || !res.ok || !eventRoom) return;
      const select = $('event-map-select');
      select.innerHTML = '';
      for (const m of res.maps) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${mapOptionLabel(m)} · 길이 ${m.height}`;
        select.appendChild(opt);
      }
      select.value = ev.map ? ev.map.id : 'classic';
      select.disabled = ev.hostId !== myId || ev.state !== 'lobby';
    });
  }

  $('event-map-select').addEventListener('change', (e) => {
    socket.emit('event:setMap', { mapId: e.target.value });
  });

  $('btn-event-random-name').addEventListener('click', () => {
    const inp = $('input-event-name');
    inp.value = randomName();
    // 아이콘 회전 연출 (재클릭해도 다시 재생되도록 리셋)
    const b = $('btn-event-random-name');
    b.classList.remove('spinning');
    void b.offsetWidth;
    b.classList.add('spinning');
  });

  $('btn-event-leave').addEventListener('click', () => {
    socket.emit('event:leave');
    eventRoom = null;
    myParticipantId = null;
    game = null; // 재생 중이었다면 렌더 루프 정지
    spectating = false;
    $('event-error').textContent = '';
    showScreen('home');
  });

  $('btn-event-register').addEventListener('click', () => {
    const name = $('input-event-name').value.trim();
    if (!name) return ($('event-error').textContent = '이름을 입력해주세요.');
    socket.emit('event:register', { name }, (res) => {
      if (!res.ok) return ($('event-error').textContent = res.error || '참가 실패');
      $('event-error').textContent = '';
      myParticipantId = res.participantId;
      $('event-my-status').textContent = `✅ "${name}" 참가 완료! (${res.participantId + 1}번 공)`;
      $('event-register-row').style.display = 'none';
    });
  });

  $('btn-event-start').addEventListener('click', () => {
    if (!eventRoom) return;
    if (eventRoom.state === 'playing') {
      socket.emit('event:again'); // 새 추첨 준비 (참가자 유지)
      myParticipantId = myParticipantId; // 참가 등록도 서버에 유지됨
    } else {
      socket.emit('event:start');
    }
  });

  /**
   * 클립보드 복사 — HTTPS 가 아닌 환경(공유기 주소, LAN IP)에서는
   * navigator.clipboard 를 쓸 수 없으므로 임시 textarea + execCommand 로 폴백한다.
   */
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        /* 아래 폴백 시도 */
      }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length); // iOS 대응
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  $('btn-event-copy').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?event=${eventRoom.code}`;
    if (await copyText(url)) {
      $('btn-event-copy').textContent = '✅ 복사 완료!';
    } else {
      prompt('아래 링크를 복사해서 공유해주세요:', url);
    }
    setTimeout(() => ($('btn-event-copy').textContent = '🔗 초대 링크 복사'), 1500);
  });

  socket.on('event:simprogress', ({ pct }) => {
    $('event-progress').classList.remove('hidden');
    $('event-progress-pct').textContent = pct;
  });

  socket.on('event:error', ({ error }) => {
    $('event-error').textContent = error || '오류가 발생했습니다.';
  });

  socket.on('event:ready', (info) => beginReplay(info));

  async function beginReplay({ replayUrl, startAt, serverNow }) {
    try {
      const replay = await (await fetch(replayUrl)).json();
      const offset = serverNow - Date.now(); // 서버 시계 보정
      startReplayPlayback(replay, startAt, offset);
    } catch {
      $('event-error').textContent = '리플레이 다운로드에 실패했습니다. 새로고침 해주세요.';
    }
  }

  function startReplayPlayback(replay, startAt, offset) {
    game = {
      board: replay.board,
      winMode: 'first',
      players: new Map(replay.players.map((p) => [p.id, p])),
      items: [],
      snapshots: [],
      countdown: 0,
      finishedRanks: [],
      overShown: false,
      camY: 0,
      explosions: [],
      blackholes: [], // 🌀 renderFrame 이 매 프레임 참조 — 없으면 크래시(리플레이도 필수)
      celebrations: [], // 🎉 우승 축포 (renderFrame 이 매 프레임 참조 — 없으면 크래시)
      fxPops: [], // 아이템 발동 순간 팝
      fxSeen: new Map(), // ballKey -> 직전 상태 플래그
      screenFx: null,
      hiddenComps: new Set(),
      shakeUntil: 0,
      replay: {
        frames: replay.frames,
        events: replay.events,
        ranking: replay.ranking,
        durationMs: replay.durationMs,
        startAt,
        offset,
        fi: 0,
        ei: 0,
      },
    };
    $('item-bar').style.display = 'none'; // 시청자는 아이템 없음 (자동 발동)
    document.querySelector('#rank-board h3').textContent = `🎪 이벤트 추첨 · 참가 ${replay.players.length}명`;
    $('rank-list').innerHTML = '';
    $('toast-area').innerHTML = '';
    $('result-modal').classList.add('hidden');
    $('target-modal').classList.add('hidden');
    showScreen('game');
    setupCanvas();
    showCheerBar(true); // 🎉 이벤트 관람 중에도 응원 가능
    requestAnimationFrame(renderFrame);
  }

  function dispatchReplayEvent(ev) {
    if (ev.type === 'finish') {
      appendFinishRow(ev);
      if (ev.rank === 1) toast(`🎉 1등 당첨: ${ev.name}!`);
    } else if (ev.type === 'item') {
      toast(
        ev.self
          ? `${ev.item.emoji} ${ev.by} → ${ev.item.name} 발동!`
          : `${ev.item.emoji} ${ev.by} → ${ev.target}에게 ${ev.item.name}!`
      );
    } else if (ev.type === 'explosion') {
      game.explosions.push({ x: ev.x, y: ev.y, radius: ev.radius, start: performance.now() });
      if (Math.abs(ev.y - (game.camY + VIEW.height / 2)) < VIEW.height) {
        game.shakeUntil = performance.now() + 250;
      }
    } else if (ev.type === 'portal') {
      if (ev.from) game.explosions.push({ x: ev.from.x, y: ev.from.y, radius: 55, start: performance.now(), color: '#35e0ff' });
      if (ev.to) game.explosions.push({ x: ev.to.x, y: ev.to.y, radius: 55, start: performance.now(), color: '#35e0ff' });
    }
  }

  // ── 대기실 ────────────────────────────────────────────
  let mapList = []; // maps:list 캐시

  // 모든 플레이어가 떠나 방이 닫힘 (관전자에게 통보)
  socket.on('room:closed', () => {
    if (!spectating) return;
    spectating = false;
    room = null;
    game = null;
    currentRoomCode = null;
    homeError.textContent = '방의 모든 플레이어가 나가서 방이 닫혔어요.';
    showScreen('home');
  });

  function applyRoomUpdate(data) {
    room = data;
    currentRoomCode = data && data.code ? data.code : currentRoomCode; // 재접속 대상 기억
    if (room.state === 'lobby' && !game && !editor.active) {
      renderLobby();
      showScreen('lobby');
    } else if (room.state === 'lobby') {
      renderLobby();
    }
  }
  socket.on('room:update', applyRoomUpdate);

  // 내 이름 인라인 편집 상태 (플레이어 목록에서 내 이름 클릭 시)
  const nameEdit = { active: false, value: '' };
  function submitInlineName() {
    const name = (nameEdit.value || '').trim();
    if (!name) return toast('⚠️ 닉네임을 입력해주세요.');
    socket.emit('room:rename', { name }, (res) => {
      if (!res || !res.ok) return toast(`⚠️ ${(res && res.error) || '변경 실패'}`);
      sessionStorage.setItem('pinball-name', res.name);
      localStorage.setItem('pinball-name-manual', res.name);
      nameEdit.active = false;
      toast(`✅ "${res.name}"(으)로 변경했어요.`);
      renderLobby();
    });
  }

  function renderLobby() {
    $('lobby-code').textContent = room.code;
    // 가까이 있는 사람은 QR을 찍어서 바로 입장 (같은 코드면 다시 그리지 않음)
    const qrBox = $('lobby-qr');
    if (qrBox.dataset.code !== room.code) {
      qrBox.dataset.code = room.code;
      try {
        /* global qrcode */
        const qr = qrcode(0, 'M');
        qr.addData(`${location.origin}${location.pathname}?room=${room.code}`);
        qr.make();
        qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
      } catch {
        qrBox.parentElement.style.display = 'none';
      }
    }
    const list = $('lobby-players');
    list.innerHTML = '';
    for (const p of room.players) {
      const li = document.createElement('li');
      const isMe = p.id === myId && !spectating;
      const hostBadge = p.id === room.hostId ? '<span class="host-badge">👑 방장</span>' : '';
      if (isMe && nameEdit.active) {
        // 내 이름 인라인 편집: 입력창 + 변경 버튼
        li.className = 'me-editing';
        li.innerHTML = `<span class="player-dot" style="background:${p.color}"></span>
          <input class="inline-name-input" type="text" maxlength="12" autocomplete="off" />
          <button class="btn small inline-name-save">변경</button>`;
        const input = li.querySelector('.inline-name-input');
        input.value = nameEdit.value;
        input.addEventListener('input', () => (nameEdit.value = input.value));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') submitInlineName();
          else if (e.key === 'Escape') { nameEdit.active = false; renderLobby(); }
        });
        li.querySelector('.inline-name-save').addEventListener('click', submitInlineName);
      } else {
        const nameHtml = `${p.isDonor ? '💖 ' : ''}${escapeHtml(p.name)}${p.id === myId ? ' (나)' : ''}`;
        li.innerHTML = `<span class="player-dot" style="background:${p.color}"></span>
          ${isMe
            ? `<button class="player-name-btn" title="클릭해서 이름 변경">${nameHtml} <span class="name-edit-pencil">✏️</span></button>`
            : `<span>${nameHtml}</span>`}
          ${hostBadge}`;
        if (isMe) {
          li.querySelector('.player-name-btn').addEventListener('click', () => {
            nameEdit.active = true;
            nameEdit.value = p.name;
            renderLobby();
          });
        }
      }
      list.appendChild(li);
    }
    // 편집 중이면 입력창에 포커스 + 커서 끝으로
    if (nameEdit.active) {
      const input = list.querySelector('.inline-name-input');
      if (input && document.activeElement !== input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
    const isHost = room.hostId === myId;
    const startBtn = $('btn-start');
    startBtn.disabled = !isHost;
    startBtn.textContent = spectating
      ? '👁 관전 중 — 게임이 시작되면 함께 봅니다'
      : isHost
        ? '🚀 게임 시작'
        : '⏳ 방장이 시작하기를 기다리는 중';
    $('btn-start-random').disabled = !isHost;
    $('btn-start-random').classList.toggle('hidden', spectating);
    // 나가기 버튼은 항상 표시 (방장이 나가면 서버가 다음 사람에게 승계)
    $('btn-leave-room').classList.remove('hidden');
    const specNote = room.spectators > 0 ? ` · 👁 관전 ${room.spectators}명` : '';
    const itemsOn = room.itemsEnabled !== false;
    const lockNote = room.locked ? '🔒 비밀방 · ' : '';
    $('lobby-hint').textContent =
      `${lockNote}${room.players.length}/${room.maxPlayers}명${specNote} · ` +
      (itemsOn ? '시작하면 각자 랜덤 아이템 2개를 받아요!' : '🚫 노템전 — 아이템 없이 순수 실력·운!');

    // 우승 조건 표시 (방장만 변경 가능)
    $('lobby-wm-first').classList.toggle('selected', room.winMode !== 'last');
    $('lobby-wm-last').classList.toggle('selected', room.winMode === 'last');
    $('lobby-wm-first').disabled = !isHost;
    $('lobby-wm-last').disabled = !isHost;

    // 아이템전 / 노템전 표시 (방장만 변경 가능)
    $('lobby-item-on').classList.toggle('selected', itemsOn);
    $('lobby-item-off').classList.toggle('selected', !itemsOn);
    $('lobby-item-on').disabled = !isHost;
    $('lobby-item-off').disabled = !isHost;
    // 아이템전이면 ⓘ 도감 아이콘을 반짝여 자연스럽게 도감 확인을 유도
    const lobbyInfo = document.querySelector('#lobby-items .items-info-btn');
    if (lobbyInfo) lobbyInfo.classList.toggle('pulse', itemsOn);

    // 인당 공 개수 (방장만 변경 가능)
    $('lobby-ball-count').value = String(room.ballsPerPlayer || 1);
    $('lobby-ball-count').disabled = !isHost;

    // 진행할 판 수 (방장만 변경 가능)
    $('lobby-round-count').value = String(room.rounds || 1);
    $('lobby-round-count').disabled = !isHost;

    refreshMaps();
  }

  $('lobby-ball-count').addEventListener('change', (e) => {
    socket.emit('room:setBalls', { ballsPerPlayer: Number(e.target.value) });
  });

  $('lobby-round-count').addEventListener('change', (e) => {
    socket.emit('room:setRounds', { rounds: Number(e.target.value) });
  });

  for (const id of ['lobby-wm-first', 'lobby-wm-last']) {
    $(id).addEventListener('click', (e) => {
      socket.emit('room:setWinMode', { winMode: e.currentTarget.dataset.mode });
    });
  }

  for (const id of ['lobby-item-on', 'lobby-item-off']) {
    $(id).addEventListener('click', (e) => {
      socket.emit('room:setItems', { itemsEnabled: e.currentTarget.dataset.items === '1' });
    });
  }

  /** 맵 옵션 라벨: 평점이 있으면 ★ 표시 (목록은 서버가 평점순으로 정렬) */
  function mapOptionLabel(m) {
    const stars = m.reviews > 0 ? ` ★${m.rating}` : '';
    // 기본 맵은 '— 기본 맵' 꼬리표를 붙이지 않는다 (유저 맵만 제작자 표시)
    const by = m.builtin ? '' : ` — ${m.author}`;
    return `${m.builtin ? '⭐' : '🛠'} ${m.name}${stars}${by}`;
  }

  function refreshMaps() {
    socket.emit('maps:list', null, (res) => {
      if (!res || !res.ok || !room) return;
      mapList = res.maps;
      const select = $('map-select');
      select.innerHTML = '';
      for (const m of mapList) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = mapOptionLabel(m);
        select.appendChild(opt);
      }
      select.value = room.map ? room.map.id : 'classic';
      select.disabled = room.hostId !== myId;
      updateMapInfo();
      renderRoundMaps();
    });
  }

  /** 시리즈(여러 판): 판마다 다른 맵을 고르는 UI. 단판이면 단일 맵 박스만 보인다. */
  function renderRoundMaps() {
    const isSeries = room && (room.rounds || 1) > 1 && Array.isArray(room.roundMaps);
    $('map-box-single').classList.toggle('hidden', !!isSeries);
    $('map-box-rounds').classList.toggle('hidden', !isSeries);
    if (!isSeries) return;
    const isHost = room.hostId === myId;
    const list = $('round-maps-list');
    list.innerHTML = '';
    for (const rm of room.roundMaps) {
      const li = document.createElement('li');
      li.className = 'round-map-row';
      const canvas = document.createElement('canvas');
      canvas.className = 'map-thumb';
      const sel = document.createElement('select');
      sel.disabled = !isHost;
      for (const m of mapList) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = mapOptionLabel(m);
        sel.appendChild(opt);
      }
      sel.value = rm.mapId;
      sel.addEventListener('change', (e) =>
        socket.emit('room:setRoundMap', { round: rm.round, mapId: e.target.value })
      );
      const label = document.createElement('span');
      label.className = 'round-map-no';
      label.textContent = `${rm.round}판`;
      li.appendChild(label);
      li.appendChild(canvas);
      li.appendChild(sel);
      list.appendChild(li);
      loadMapThumb(canvas, rm.mapId);
    }
  }

  function updateMapInfo() {
    const mapId = $('map-select').value;
    const meta = mapList.find((m) => m.id === mapId);
    if (!meta) return ($('map-info').textContent = '');
    const rating = meta.reviews > 0 ? `★${meta.rating} (후기 ${meta.reviews}개) · ` : '';
    $('map-info').textContent = `${rating}구성요소 ${meta.count}개 · 길이 ${meta.height} · ${room.hostId === myId ? '맵을 선택하세요' : '방장이 맵을 선택합니다'}`;
    // 선택된 맵의 미리보기 썸네일
    if (mapId) loadMapThumb($('lobby-map-thumb'), mapId);
  }

  $('map-select').addEventListener('change', (e) => {
    socket.emit('room:setMap', { mapId: e.target.value });
  });

  // ── 맵 후기 (커뮤니티) ────────────────────────────────
  let reviewRating = 5;
  function renderStarPicker() {
    const picker = $('star-picker');
    picker.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement('button');
      b.className = 'star-btn' + (i <= reviewRating ? ' on' : '');
      b.textContent = '★';
      b.title = `${i}점`;
      b.addEventListener('click', () => {
        reviewRating = i;
        renderStarPicker();
      });
      picker.appendChild(b);
    }
  }

  let reviewTarget = { mapId: null, name: '맵' }; // 후기 모달이 가리키는 맵

  function openReviews(mapId, mapName, keepForm) {
    reviewTarget = { mapId, name: mapName || '맵' };
    socket.emit('reviews:list', { mapId }, (res) => {
      if (!res || !res.ok) return;
      $('review-title').textContent = `💬 「${reviewTarget.name}」 후기`;
      $('review-summary').textContent =
        res.count > 0
          ? `★ ${res.avg} · 후기 ${res.count}개`
          : '아직 후기가 없어요 — 첫 후기를 남겨주세요!';
      const list = $('review-list');
      list.innerHTML = '';
      if (!res.reviews.length) {
        list.innerHTML =
          '<li class="review-empty">이 맵을 플레이해봤다면 별점과 한 줄 평을 남겨주세요.</li>';
      }
      for (const v of res.reviews) {
        const li = document.createElement('li');
        li.innerHTML = `<div class="review-head">
            <span class="review-stars">${'★'.repeat(v.rating)}${'☆'.repeat(5 - v.rating)}</span>
            <span class="review-name">${escapeHtml(v.name)}</span>
            <span class="review-date">${new Date(v.at).toLocaleDateString()}</span>
          </div>
          ${v.text ? `<div class="review-text">${escapeHtml(v.text)}</div>` : ''}`;
        list.appendChild(li);
      }
      if (!keepForm) {
        reviewRating = 5;
        renderStarPicker();
        $('input-review-text').value = '';
        $('review-msg').textContent = '';
      }
      $('review-modal').classList.remove('hidden');
    });
  }

  $('btn-reviews').addEventListener('click', () => {
    const mapId = $('map-select').value;
    const meta = mapList.find((m) => m.id === mapId);
    openReviews(mapId, meta ? meta.name : '맵', false);
  });
  $('btn-review-close').addEventListener('click', () =>
    $('review-modal').classList.add('hidden')
  );

  $('btn-review-submit').addEventListener('click', () => {
    socket.emit(
      'reviews:add',
      {
        mapId: reviewTarget.mapId,
        rating: reviewRating,
        text: $('input-review-text').value,
        name: myName(),
      },
      (res) => {
        if (!res.ok) return ($('review-msg').textContent = res.error || '등록 실패');
        $('input-review-text').value = '';
        openReviews(reviewTarget.mapId, reviewTarget.name, false); // 목록 새로고침
        if (room) refreshMaps(); // 대기실 드롭다운 별점 반영
        if (document.getElementById('screen-maps').classList.contains('active')) {
          renderMapsGallery(); // 갤러리 별점 반영
        }
      }
    );
  });

  // ── 🗺 맵 갤러리 ──────────────────────────────────────
  const mapThumbCache = new Map(); // mapId -> 맵 정의 (썸네일용)

  /** 맵 전체를 세로로 압축한 미니 스냅샷 — 구성요소를 색점·색선으로 그린다 */
  function drawMapThumb(canvas, map) {
    const W = 56;
    const H = 112;
    const dpr = 2;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const c2 = canvas.getContext('2d');
    const sx = (W * dpr) / (map.width || WORLD.width);
    const sy = (H * dpr) / map.height;
    c2.fillStyle = '#07070b';
    c2.fillRect(0, 0, W * dpr, H * dpr);
    for (const comp of map.components) {
      const built = buildShapes(comp.type, comp.props);
      if (!built) continue;
      for (const sh of built.shapes) {
        const color = sh.glow || sh.fill || '#35e0ff';
        const px = (comp.x + (sh.x || 0)) * sx;
        const py = (comp.y + (sh.y || 0)) * sy;
        c2.fillStyle = color;
        if (sh.kind === 'circle') {
          const r = Math.max(1.3, sh.r * sx * 0.55);
          c2.beginPath();
          c2.arc(px, py, r, 0, Math.PI * 2);
          c2.fill();
        } else {
          const len = Math.max(2.5, (sh.w || 0) * sx);
          c2.save();
          c2.translate(px, py);
          c2.rotate(sh.angle || 0);
          c2.fillRect(-len / 2, -0.9, len, 1.8);
          c2.restore();
        }
      }
    }
    // 골인선
    c2.fillStyle = 'rgba(53,224,255,0.9)';
    c2.fillRect(0, H * dpr - 3, W * dpr, 2);
  }

  /** 맵 정의를 (캐시해서) 가져와 썸네일을 그린다 */
  function loadMapThumb(canvas, mapId) {
    const cached = mapThumbCache.get(mapId);
    if (cached) return drawMapThumb(canvas, cached);
    socket.emit('maps:get', { mapId }, (res) => {
      if (!res || !res.ok) return;
      mapThumbCache.set(mapId, res.map);
      drawMapThumb(canvas, res.map);
    });
  }

  /** 큰 별점 표기: ★★★★☆ 4.2 (12) — 카드 상단에 눈에 띄게 */
  function starsHtml(m) {
    if (!m.reviews) return `<div class="map-stars empty">☆☆☆☆☆ <span>아직 평가 없음</span></div>`;
    const filled = Math.max(0, Math.min(5, Math.round(m.rating)));
    return `<div class="map-stars">${'★'.repeat(filled)}${'☆'.repeat(5 - filled)}
      <b>${m.rating}</b> <span>(${m.reviews})</span></div>`;
  }

  function renderMapsGallery() {
    socket.emit('maps:list', null, (res) => {
      if (!res || !res.ok) return;
      const list = $('maps-list');
      list.innerHTML = '';
      for (const m of res.maps) {
        const li = document.createElement('li');
        li.innerHTML = `<canvas class="map-thumb" title="맵 미리보기"></canvas>
          <div class="map-mid">
            ${starsHtml(m)}
            <div class="map-title">${m.builtin ? '⭐' : '🛠'} ${escapeHtml(m.name)}</div>
            <div class="map-meta">${escapeHtml(m.author)} · 길이 ${m.height} · 구성요소 ${m.count}개</div>
          </div>
          <div class="map-actions">
            <button class="btn small" data-view="${m.id}">👁 구경</button>
            <button class="btn small" data-review="${m.id}" data-name="${escapeHtml(m.name)}">💬</button>
          </div>`;
        list.appendChild(li);
        loadMapThumb(li.querySelector('.map-thumb'), m.id);
      }
      list.querySelectorAll('[data-view]').forEach((btn) =>
        btn.addEventListener('click', () => viewMap(btn.dataset.view))
      );
      list.querySelectorAll('[data-review]').forEach((btn) =>
        btn.addEventListener('click', () =>
          openReviews(btn.dataset.review, btn.dataset.name, false)
        )
      );
    });
  }

  /** 맵 구경: 에디터를 읽기 전용 뷰어로 연다 */
  function viewMap(mapId) {
    socket.emit('maps:get', { mapId }, (res) => {
      if (!res || !res.ok) return;
      openEditor({ viewOnly: true, map: res.map });
    });
  }

  $('btn-maps').addEventListener('click', () => {
    renderMapsGallery();
    showScreen('maps');
  });
  $('btn-maps-back').addEventListener('click', () => {
    if (room) {
      renderLobby();
      showScreen('lobby');
    } else {
      showScreen('home');
    }
  });
  $('btn-new-map').addEventListener('click', () => openEditor({ from: 'maps' }));

  // 방 코드를 클릭하면 초대 링크 복사
  $('lobby-code').addEventListener('click', async () => {
    if (!room) return;
    const url = `${location.origin}${location.pathname}?room=${room.code}`;
    const hint = $('lobby-copy-hint');
    if (await copyText(url)) {
      hint.textContent = '✅ 초대 링크가 복사됐어요!';
      hint.classList.add('copied');
    } else {
      prompt('아래 링크를 복사해서 친구에게 보내주세요:', url);
    }
    setTimeout(() => {
      hint.textContent = '🔗 코드를 클릭하면 초대 링크 복사';
      hint.classList.remove('copied');
    }, 1600);
  });

  $('btn-start').addEventListener('click', () => socket.emit('game:start'));
  $('btn-start-random').addEventListener('click', () => socket.emit('game:startRandom'));
  $('btn-leave-room').addEventListener('click', () => {
    socket.emit('room:leave');
    spectating = false;
    room = null;
    currentRoomCode = null; // 명시적으로 나가면 재접속 대상 해제
    showScreen('home');
  });

  // 대기실에서 내 닉네임 변경
  // ── 게임 시작 ─────────────────────────────────────────
  // 시작 브로드캐스트와 관전 중간 합류가 같은 진입점을 쓴다
  function startGameView({ board, players, yourItems, winMode, ballsPerPlayer, shuffle, autoPilot, spectator, finished, introMs }) {
    game = {
      board,
      autoPilot: !!autoPilot,
      spectator: !!spectator,
      winMode: winMode || 'first',
      ballsPer: ballsPerPlayer || 1,
      shuffling: !!shuffle,
      players: new Map(players.map((p) => [p.id, p])),
      items: yourItems, // [{id,name,emoji,desc,target,duration} | null]
      snapshots: [],
      clockOffset: null, // 서버 시계 추정치 (보간용)
      countdown: 0,
      finishedRanks: [],
      overShown: false,
      camY: 0,
      explosions: [], // {x, y, radius, start} — 폭발 애니메이션
      blackholes: [], // {x, y, radius, start, duration} — 🌀 블랙홀 흡입 범위
      celebrations: [], // {x, y, start, particles} — 🎉 우승 축포
      fxPops: [], // {x, y, emoji, label, color, start} — 아이템 발동 순간 팝
      fxSeen: new Map(), // ballKey -> 직전 상태 플래그 (발동 순간 감지용)
      screenFx: null, // {emoji, label, color, start} — 내 공이 당했을 때 화면 전체 알림
      hiddenComps: new Set(), // 터져서 잠시 사라진 구성요소 인덱스
      shakeUntil: 0,
    };
    game.speedMult = 1;
    renderSpeedRow();
    miniStatic = null; // 새 게임 → 미니맵 정적 캐시 갱신
    $('rank-list').innerHTML = '';
    $('toast-area').innerHTML = '';
    // 올랜덤·관전자·노템전은 아이템 바 숨김
    const hasItems = !game.autoPilot && !game.spectator && (game.items || []).some(Boolean);
    $('item-bar').style.display = hasItems ? '' : 'none';
    if (game.autoPilot) {
      toast(
        `🎲 올랜덤 — 맵: ${board.mapName} · 인당 공 ${game.ballsPer}개 · ${game.winMode === 'last' ? '🐢 늦게' : '🥇 먼저'} 골인 우승`
      );
    }
    if (game.spectator) toast('👁 관전 모드 — 경기를 지켜보는 중입니다');
    // 순위판 제목에 우승 조건(+ 시리즈면 현재 판) 표시
    const roundTag = room && room.series ? `🔁 ${room.series.roundNo}/${room.series.total}판 · ` : '';
    document.querySelector('#rank-board h3').textContent =
      roundTag +
      (game.autoPilot ? '🎲 올랜덤 · ' : game.spectator ? '👁 관전 · ' : '') +
      (game.winMode === 'last' ? '도착 순서 · 🐢 늦게 골인 당첨' : '순위 · 🥇 먼저 골인 우승');
    $('result-modal').classList.add('hidden');
    $('series-modal').classList.add('hidden'); // 다음 판 시작 → 라운드 사이 화면 닫기
    if (seriesCountTimer) {
      clearInterval(seriesCountTimer);
      seriesCountTimer = null;
    }
    $('target-modal').classList.add('hidden');
    // 아이템전 시작 시 잠깐 아이템 소개 시간을 가진다 (서버가 그동안 셔플·낙하를 멈춘다)
    game.introEndsAt = introMs > 0 ? performance.now() + introMs : 0;
    renderItems();
    showIntro();
    showScreen('game'); // 화면 표시 후에 캔버스 크기 계산 (숨김 상태에선 부모 크기가 0)
    setupCanvas();
    showCheerBar(true); // 🎉 응원 바 표시
    // 중간 합류: 지금까지의 도착 기록을 순위판에 복원
    if (finished) for (const f of finished) appendFinishRow(f);
    requestAnimationFrame(renderFrame);
  }
  socket.on('game:started', startGameView);

  // ── 🎉 이모지 응원 ───────────────────────────────────
  // server/cheers.js 의 허용 목록과 순서·구성이 일치해야 한다.
  const CHEERS = ['👏', '🔥', '🎉', '😂', '😮', '❤️', '😱', '💪', '🍀', '🙏'];
  function buildCheerBar() {
    const bar = $('cheer-bar');
    if (bar.dataset.built) return;
    bar.dataset.built = '1';
    for (const e of CHEERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cheer-btn';
      b.textContent = e;
      b.setAttribute('aria-label', '응원 ' + e);
      b.addEventListener('click', () => sendCheer(e));
      bar.appendChild(b);
    }
  }
  function showCheerBar(show) {
    buildCheerBar();
    $('cheer-bar').classList.toggle('hidden', !show);
    if (!show) $('cheer-layer').innerHTML = '';
  }
  let lastCheerAt = 0;
  function sendCheer(emoji) {
    const now = performance.now();
    if (now - lastCheerAt < 220) return; // 연타 완화 (서버도 제한)
    lastCheerAt = now;
    // 이벤트 리플레이 관람이면 이벤트 채널로, 아니면 방 채널로
    if (game && game.replay) socket.emit('event:cheer', { emoji });
    else socket.emit('room:cheer', { emoji });
    // 서버가 나를 포함해 방송하므로 여기서 별도 표시는 하지 않는다(중복 방지)
  }
  function spawnCheer(emoji) {
    const layer = $('cheer-layer');
    if (!layer) return;
    if (layer.childElementCount > 40) layer.removeChild(layer.firstChild); // 폭주 방지
    const el = document.createElement('span');
    el.className = 'cheer-fly';
    el.textContent = emoji;
    el.style.left = (6 + Math.random() * 82).toFixed(1) + '%';
    el.style.setProperty('--drift', (Math.random() * 44 - 22).toFixed(0) + 'px');
    el.style.setProperty('--rot', (Math.random() * 36 - 18).toFixed(0) + 'deg');
    el.style.fontSize = (26 + Math.random() * 14).toFixed(0) + 'px';
    el.addEventListener('animationend', () => el.remove());
    layer.appendChild(el);
  }
  socket.on('room:cheer', ({ emoji } = {}) => spawnCheer(emoji));
  socket.on('event:cheer', ({ emoji } = {}) => spawnCheer(emoji));

  socket.on('game:snapshot', (snap) => {
    if (!game || game.replay) return;
    snap.recv = performance.now();
    // 서버 시계 추정: 지연이 가장 적었던 패킷 기준(지터에 흔들리지 않도록 슬라이딩 최대값).
    // 위로 튈 때도 한 번에 크게 당기지 않고 최대 6ms/스냅으로 완만히 따라가, 유난히 빨리 온
    // 패킷 하나가 renderT 를 순간 이동시켜 화면 전체가 한 프레임 튀는 것을 막는다.
    const inst = snap.t - snap.recv;
    if (game.clockOffset == null) {
      game.clockOffset = inst;
    } else {
      const target = Math.max(inst, game.clockOffset - 4); // 아래로는 4ms/스냅 감쇠(기존)
      const delta = target - game.clockOffset;
      game.clockOffset += delta > 6 ? 6 : delta; // 위로는 최대 6ms/스냅
    }
    game.snapshots.push(snap);
    if (game.snapshots.length > 12) game.snapshots.shift();
    game.countdown = snap.countdown;
    // 셔플 → 낙하 전환 순간 "GO!" 표시
    if (game.shuffling && !snap.sh) {
      toast('🎲 낙하 시작!');
    }
    game.shuffling = !!snap.sh;
    updateHiddenComps(snap.off);
  });

  // 숨김 구성요소 집합을 재사용 Set 으로 갱신하고, 실제로 바뀐 경우에만 버전을 올린다
  // (버전이 바뀔 때만 미니맵 정적 캐시가 재생성되므로 무의미한 재생성 방지)
  function sameOff(prev, next) {
    const a = prev || [];
    const b = next || [];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; // 서버가 인덱스 순으로 보냄
    return true;
  }
  function updateHiddenComps(off) {
    off = off || [];
    if (sameOff(game._offPrev, off)) return;
    game.hiddenComps.clear();
    for (const i of off) game.hiddenComps.add(i);
    game._offPrev = off; // 파싱된 메시지의 배열 참조 보관 (다음 비교용)
    game.hiddenVersion = (game.hiddenVersion || 0) + 1;
  }

  $('btn-drop').addEventListener('click', () => {
    socket.emit('game:drop');
    $('btn-drop').classList.add('hidden');
  });

  // ── ⏩ 배속 (방장 전용 조작, 전원에게 반영) ──────────────
  function renderSpeedRow() {
    if (!game) return $('speed-row').classList.add('hidden');
    const isHost = room && room.hostId === myId;
    $('speed-row').classList.toggle(
      'hidden',
      !isHost || !!game.replay || game.autoPilot || game.spectator
    );
    document.querySelectorAll('.speed-btn').forEach((b) => {
      b.classList.toggle('selected', Number(b.dataset.mult) === (game.speedMult || 1));
    });
  }

  document.querySelectorAll('.speed-btn').forEach((b) =>
    b.addEventListener('click', () => socket.emit('game:setSpeed', { mult: Number(b.dataset.mult) }))
  );

  socket.on('game:speed', ({ mult }) => {
    if (!game) return;
    game.speedMult = mult;
    renderSpeedRow();
    toast(`⏩ ${mult}배속!`);
  });

  socket.on('game:explosion', ({ x, y, radius }) => {
    if (!game) return;
    game.explosions.push({ x, y, radius, start: performance.now() });
    // 화면 안에서 터졌으면 카메라 흔들기
    if (Math.abs(y - (game.camY + VIEW.height / 2)) < VIEW.height) {
      game.shakeUntil = performance.now() + 250;
    }
  });

  // 🌀 포탈 순간이동 / 🦘 점프 패드 발동 — 시안 링 이펙트 (흔들림 없음)
  socket.on('game:portal', ({ from, to }) => {
    if (!game) return;
    if (from) game.explosions.push({ x: from.x, y: from.y, radius: 55, start: performance.now(), color: '#35e0ff' });
    if (to) game.explosions.push({ x: to.x, y: to.y, radius: 55, start: performance.now(), color: '#35e0ff' });
  });

  // 🌀 블랙홀 발동: 흡입 범위를 소용돌이 장으로 표시
  socket.on('game:blackhole', ({ x, y, radius, duration }) => {
    if (!game) return;
    game.blackholes.push({ x, y, radius, duration: duration || 1300, start: performance.now() });
    game.shakeUntil = performance.now() + 300;
  });

  // 🎡 인생은 돌고돌아 발동: 골인 직전의 공이 원점으로
  socket.on('game:karma', ({ name, x, y }) => {
    if (!game) return;
    toast(`🎡 인생은 돌고돌아! ${name}의 공이 골인 직전에 원점으로...!`);
    game.explosions.push({ x, y, radius: 130, start: performance.now() });
    game.shakeUntil = performance.now() + 350;
  });

  /** 실시간 순위판에 도착 기록 추가 (10명까지, 이후는 카운터) */
  function appendFinishRow({ playerId, name, rank, timeMs, p: participantId }) {
    const key = playerId !== undefined ? playerId : participantId;
    game.finishedRanks.push({ playerId: key, name, rank });
    const list = $('rank-list');
    if (rank <= 10) {
      const p = game.players.get(key);
      const isLast = game.winMode === 'last';
      const mineKey = game.replay ? myParticipantId : myId;
      const li = document.createElement('li');
      // 늦게 골인 모드에서는 도착 순서가 순위와 반대이므로 "n번째 도착"으로 표시
      li.innerHTML = `<span class="rank-num">${rank}${isLast ? '번째' : '등'}</span>
        <span class="player-dot" style="background:${p ? p.color : '#888'}"></span>
        <span>${escapeHtml(name)}${key === mineKey ? ' (나)' : ''}</span>
        <span class="result-time">${formatTime(timeMs)}</span>`;
      list.appendChild(li);
    } else {
      let more = document.getElementById('rank-more');
      if (!more) {
        more = document.createElement('li');
        more.id = 'rank-more';
        list.appendChild(more);
      }
      more.textContent = `... 외 ${rank - 10}명 도착`;
    }
  }

  socket.on('game:ballFinished', (data) => {
    if (!game || game.replay) return;
    appendFinishRow(data);
    if (data.celebrate) {
      spawnCelebration(data.celebrateX, data.name);
    } else if (data.rank === 1) {
      toast(
        game.winMode === 'last'
          ? `⚡ ${data.name}님이 가장 먼저 도착... 늦게 골인이 당첨인데요!`
          : `🏆 ${data.name}님이 1등으로 도착!`
      );
    }
  });

  // 🎉 우승 축포: 골인 지점에서 색색 컨페티가 펑! 하고 터진다
  const CELEB_COLORS = ['#ff5c7a', '#ffd12e', '#35e0ff', '#9bec00', '#c86bff', '#ff9d2e', '#fff3b0'];
  function spawnCelebration(x, name) {
    if (!game || !game.board) return;
    const ox = typeof x === 'number' ? x : game.board.goal.x;
    const oy = game.board.goal.y - 6;
    const particles = [];
    for (let i = 0; i < 70; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.3; // 위쪽으로 부채꼴
      const s = 0.16 + Math.random() * 0.22; // px/ms
      particles.push({
        a,
        s,
        color: CELEB_COLORS[(Math.random() * CELEB_COLORS.length) | 0],
        w: 4 + Math.random() * 5,
        h: 7 + Math.random() * 7,
        rot: Math.random() * Math.PI,
        rotSpeed: (Math.random() - 0.5) * 0.02,
      });
    }
    game.celebrations.push({ x: ox, y: oy, start: performance.now(), particles });
    toast(`🎉 ${name}님 우승! 축하합니다! 🎊`);
  }

  function formatTime(timeMs) {
    return timeMs == null ? '' : (timeMs / 1000).toFixed(1) + '초';
  }

  socket.on('game:itemUsed', ({ by, item, target, self }) => {
    toast(
      self
        ? `${item.emoji} ${by} → ${item.name} 사용!`
        : `${item.emoji} ${by} → ${target}에게 ${item.name}!`
    );
  });

  socket.on('game:over', ({ ranking, series }) => {
    if (!game || game.replay) return;
    game.overShown = true;
    // 시리즈(여러 판) 진행 중이면 일반 결과창 대신 시리즈 화면(series:next/over)이 그린다.
    // 방금 판 순위는 저장해 두었다가 라운드 사이 화면에서 보여준다.
    if (series) {
      seriesLastRound = { round: series.round, total: series.total, ranking };
      return;
    }
    showResults(ranking, { event: false });
  });

  // ── 🔁 시리즈(여러 판) 화면 ──────────────────────────────
  let seriesLastRound = null; // 방금 끝난 판의 { round, total, ranking }

  /** 누적 순위표 HTML (place · 이름 · 점수). winner/loser 강조 옵션 */
  function standingsHtml(standings, { highlight = false } = {}) {
    const mineKey = myId;
    const last = standings.length - 1;
    const medal = (p) => (p === 1 ? '🥇' : p === 2 ? '🥈' : p === 3 ? '🥉' : `${p}등`);
    return (
      '<ol class="series-standings">' +
      standings
        .map((r, i) => {
          const cls =
            highlight && i === 0 ? ' winner' : highlight && i === last && standings.length > 1 ? ' loser' : '';
          return `<li class="series-row${cls}">
            <span class="series-place">${medal(r.place)}</span>
            <span class="player-dot" style="background:${r.color}"></span>
            <span class="series-name">${escapeHtml(r.name)}${r.playerId === mineKey ? ' (나)' : ''}</span>
            <span class="series-score">${r.score}점</span>
          </li>`;
        })
        .join('') +
      '</ol>'
    );
  }

  /** 라운드 사이 인터스티셜: 방금 판 순위 + 누적 순위 + 카운트다운 */
  socket.on('series:next', ({ round, total, standings, startInMs, mapName }) => {
    if (!game && !room) return;
    $('result-modal').classList.add('hidden');
    const title = $('series-title');
    const body = $('series-body');
    const foot = $('series-foot');
    title.textContent = `🔁 ${round - 1}판 종료 — 곧 ${round}/${total}판 시작!`;
    let html = '';
    if (mapName) html += `<div class="series-nextmap">🗺 다음 맵 · <b>${escapeHtml(mapName)}</b></div>`;
    if (seriesLastRound) {
      html += `<div class="series-section-label">방금 판 순위</div>`;
      html += `<ol class="series-standings compact">${seriesLastRound.ranking
        .map(
          (r) => `<li class="series-row">
            <span class="series-place">${r.rank}등</span>
            <span class="player-dot" style="background:${r.color}"></span>
            <span class="series-name">${escapeHtml(r.name)}${r.playerId === myId ? ' (나)' : ''}</span>
            <span class="series-score">${r.finished ? formatTime(r.timeMs) : '미도착'}</span>
          </li>`
        )
        .join('')}</ol>`;
    }
    html += `<div class="series-section-label">누적 순위 (${round - 1}판 합산)</div>`;
    html += standingsHtml(standings);
    body.innerHTML = html;
    let sec = Math.ceil((startInMs || 6000) / 1000);
    const tick = () => {
      foot.innerHTML = `<div class="series-count">${round}판 시작까지 <b>${sec}</b>초…</div>`;
    };
    tick();
    if (seriesCountTimer) clearInterval(seriesCountTimer);
    seriesCountTimer = setInterval(() => {
      sec -= 1;
      if (sec <= 0) {
        clearInterval(seriesCountTimer);
        seriesCountTimer = null;
        foot.innerHTML = `<div class="series-count">잠시 후 시작합니다…</div>`;
        return;
      }
      tick();
    }, 1000);
    $('series-modal').classList.remove('hidden');
  });
  let seriesCountTimer = null;

  /** 최종 결과: 우승자/벌칙자 + 누적 순위 + 판별 순위 */
  socket.on('series:over', ({ total, standings, rounds }) => {
    if (seriesCountTimer) {
      clearInterval(seriesCountTimer);
      seriesCountTimer = null;
    }
    $('result-modal').classList.add('hidden');
    const win = standings[0];
    const lose = standings.length > 1 ? standings[standings.length - 1] : null;
    $('series-title').textContent = `🏆 최종 결과 (총 ${total}판)`;
    let html = '';
    html += `<div class="series-final-banner win">🏆 최종 우승 · <b>${escapeHtml(
      win ? win.name : '?'
    )}</b> <span>${win ? win.score : 0}점</span></div>`;
    if (lose) {
      html += `<div class="series-final-banner lose">💀 벌칙 당첨(꼴찌) · <b>${escapeHtml(
        lose.name
      )}</b> <span>${lose.score}점</span></div>`;
    }
    html += `<div class="series-section-label">최종 누적 순위</div>`;
    html += standingsHtml(standings, { highlight: true });
    html += `<div class="series-section-label">판별 순위</div>`;
    html += '<div class="series-rounds">';
    for (const rd of rounds) {
      const order = rd.ranking
        .map((r) => {
          const m = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `${r.rank}.`;
          return `<span class="series-round-name">${m} ${escapeHtml(r.name)}</span>`;
        })
        .join('');
      html += `<div class="series-round-line"><span class="series-round-no">${rd.round}판</span>${order}</div>`;
    }
    html += '</div>';
    $('series-body').innerHTML = html;
    $('series-foot').innerHTML = `<button id="btn-series-back" class="btn primary">대기실로 돌아가기</button>`;
    $('btn-series-back').addEventListener('click', () => {
      $('series-modal').classList.add('hidden');
      game = null;
      if (room) {
        renderLobby();
        showScreen('lobby');
      } else {
        showScreen('home');
      }
    });
    $('series-modal').classList.remove('hidden');
    startSeriesConfetti();
  });

  /** 최종 결과 화면 (아이템전/이벤트 추첨 공용) */
  function showResults(ranking, { event = false } = {}) {
    const mineKey = event ? myParticipantId : myId;
    // "이번 판 순위" 보기용으로 이번 결과를 저장
    lastRanking = ranking;
    lastRankingEvent = event;
    lastRankingWinMode = game ? game.winMode : 'first';

    // 우승자 배너
    const winner = ranking[0];
    $('winner-banner').textContent = winner
      ? event
        ? `🎉 1등 당첨: ${winner.name}${winner.playerId === mineKey ? ' (나!)' : ''}`
        : `🏆 ${winner.name}${winner.playerId === mineKey ? ' (나)' : ''} 우승!`
      : '';

    // 시상대 (1~3등, 표시 순서: 2등-1등-3등)
    const podium = $('podium');
    podium.innerHTML = '';
    const medals = ['🥇', '🥈', '🥉'];
    const classes = ['first', 'second', 'third'];
    const top3 = ranking.slice(0, 3);
    const order = [top3[1], top3[0], top3[2]].filter(Boolean);
    for (const r of order) {
      const col = document.createElement('div');
      col.className = `podium-col ${classes[r.rank - 1]}`;
      col.innerHTML = `
        <span class="podium-medal">${medals[r.rank - 1]}</span>
        <span class="podium-ball" style="background:${r.color};color:${r.color}"></span>
        <span class="podium-name">${escapeHtml(r.name)}${r.playerId === mineKey ? ' ★' : ''}</span>
        <span class="podium-time">${r.finished ? formatTime(r.timeMs) : '미도착'}</span>
        <div class="podium-block">${r.rank}등</div>`;
      podium.appendChild(col);
    }

    // 4등 이하 목록 (최대 50명 표시)
    const list = $('result-list');
    list.innerHTML = '';
    for (const r of ranking.slice(3, 53)) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="rank-num">${r.rank}등</span>
        <span class="player-dot" style="background:${r.color}"></span>
        <span>${escapeHtml(r.name)}${r.playerId === mineKey ? ' (나)' : ''}</span>
        <span class="result-time">${r.finished ? formatTime(r.timeMs) : '미도착'}</span>`;
      list.appendChild(li);
    }
    if (ranking.length > 53) {
      const li = document.createElement('li');
      li.style.justifyContent = 'center';
      li.style.color = 'var(--muted)';
      li.textContent = `... 외 ${ranking.length - 53}명`;
      list.appendChild(li);
    }

    $('btn-back-lobby').textContent = event ? '이벤트로 돌아가기' : '대기실로 돌아가기';
    $('result-modal').classList.remove('hidden');
    startConfetti();
  }

  // ── 색종이 + 폭죽 축하 효과 ────────────────────────────
  // 금박·은박·크림슨 색종이 비 + 화려하게 터지는 폭죽(불꽃놀이)
  const CONFETTI_COLORS = ['#d4af37', '#e8d48b', '#b23a48', '#f0ead6', '#c0c0c8', '#8a6d4a'];
  const FIREWORK_COLORS = ['#ff5c7a', '#ffd12e', '#35e0ff', '#9bec00', '#c86bff', '#ff9d2e', '#fff3b0'];
  function startSeriesConfetti() {
    startConfetti('series-confetti', 'series-confetti-front', 'series-modal');
  }
  // 색종이(back 캔버스, 카드 뒤) + 폭죽(front 캔버스, 카드 앞)을 각각 그린다.
  function startConfetti(backId = 'confetti', frontId = 'confetti-front', modalId = 'result-modal') {
    const c = $(backId);
    const cxf = $(frontId).getContext('2d');
    const cFront = $(frontId);
    c.width = c.clientWidth;
    c.height = c.clientHeight;
    cFront.width = c.width;
    cFront.height = c.height;
    const cx = c.getContext('2d');
    // 색종이 비 (배경에 은은하게 계속)
    const parts = Array.from({ length: 110 }, () => ({
      x: Math.random() * c.width,
      y: -Math.random() * c.height * 0.6,
      w: 5 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      vy: 1.6 + Math.random() * 2.6,
      vx: (Math.random() - 0.5) * 1.4,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.18,
    }));

    // 폭죽(불꽃놀이): 무작위 위치에서 방사형으로 펑! 하고 터진다
    const sparks = [];
    function burst(bx, by) {
      const color = FIREWORK_COLORS[(Math.random() * FIREWORK_COLORS.length) | 0];
      const n = 46 + ((Math.random() * 26) | 0);
      const power = 3.4 + Math.random() * 2.2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
        const sp = power * (0.55 + Math.random() * 0.7);
        sparks.push({
          x: bx, y: by,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          // 일부는 흰빛 반짝이로 섞어 화려함 UP
          color: Math.random() < 0.18 ? '#ffffff' : color,
          r: 1.6 + Math.random() * 2.2,
          life: 0,
          ttl: 780 + Math.random() * 620,
        });
      }
    }
    // 등장 직후 화려하게 여러 발 연속으로 터뜨린다 (0.9초간)
    const start = performance.now();
    const schedule = [0, 180, 340, 520, 720, 900].map((t) => ({
      t,
      x: c.width * (0.2 + Math.random() * 0.6),
      y: c.height * (0.22 + Math.random() * 0.3),
      fired: false,
    }));

    let last = start;
    const step = (now) => {
      if ($(modalId).classList.contains('hidden')) {
        cx.clearRect(0, 0, c.width, c.height);
        cxf.clearRect(0, 0, c.width, c.height);
        return; // 화면 닫히면 종료
      }
      const dt = Math.min(48, now - last);
      last = now;
      const elapsed = now - start;
      // 예약된 폭죽 발사
      for (const s of schedule) {
        if (!s.fired && elapsed >= s.t) {
          s.fired = true;
          burst(s.x, s.y);
        }
      }

      // ── 뒤(back) 캔버스: 색종이 비 — 카드 뒤에서 흩날림 ──
      cx.clearRect(0, 0, c.width, c.height);
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        if (p.y > c.height + 20) {
          p.y = -20;
          p.x = Math.random() * c.width;
        }
        cx.save();
        cx.translate(p.x, p.y);
        cx.rotate(p.rot);
        cx.fillStyle = p.color;
        cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        cx.restore();
      }

      // ── 앞(front) 캔버스: 폭죽 불꽃 — 결과 카드 앞에서 터짐 ──
      cxf.clearRect(0, 0, c.width, c.height);
      cxf.save();
      cxf.globalCompositeOperation = 'lighter';
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.life += dt;
        if (s.life >= s.ttl) {
          sparks.splice(i, 1);
          continue;
        }
        const k = dt / 16.7;
        s.x += s.vx * k;
        s.y += s.vy * k;
        s.vy += 0.05 * k; // 중력
        s.vx *= 0.985;
        s.vy *= 0.985;
        const alpha = 1 - s.life / s.ttl;
        cxf.globalAlpha = alpha;
        cxf.fillStyle = s.color;
        cxf.shadowColor = s.color;
        cxf.shadowBlur = 8;
        cxf.beginPath();
        cxf.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        cxf.fill();
      }
      cxf.restore();

      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  $('btn-back-lobby').addEventListener('click', () => {
    $('result-modal').classList.add('hidden');
    showCheerBar(false);
    const wasReplay = game && game.replay;
    game = null;
    if (wasReplay && eventRoom) {
      renderEventScreen(eventRoom);
      showScreen('event');
    } else if (room) {
      renderLobby();
      showScreen('lobby');
    } else {
      showScreen('home');
    }
  });

  socket.on('disconnect', () => {
    // 🔌 방에 속해 있었다면 상태를 지우지 않고 재접속을 기다린다 (자리 유지)
    if (currentRoomCode) {
      showReconnecting();
      return;
    }
    room = null;
    game = null;
    spectating = false;
    homeError.textContent = '서버와의 연결이 끊어졌습니다. 새로고침 해주세요.';
    showScreen('home');
  });

  // ── 🔌 재접속 오버레이 & 헬퍼 ──────────────────────────
  function reconnectOverlay() {
    let el = $('reconnect-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'reconnect-overlay';
      el.className = 'reconnect-overlay hidden';
      el.innerHTML = `<div class="reconnect-box">
        <div class="reconnect-spinner"></div>
        <div class="reconnect-text">재접속 중…</div>
        <div class="reconnect-sub">잠깐 끊겼어요. 자리를 지키는 중이에요.</div>
      </div>`;
      document.body.appendChild(el);
    }
    return el;
  }
  function showReconnecting() {
    reconnectOverlay().classList.remove('hidden');
  }
  function hideReconnecting() {
    reconnectOverlay().classList.add('hidden');
  }
  function resumeGameFromPayload(payload) {
    // 게임 진행 중 재접속: 관전 진입점과 동일한 경로로 렌더 재개 (본인 아이템 포함)
    startGameView(payload);
    // 스냅샷 버퍼가 비어 첫 프레임이 튀는 걸 감추려 잠깐 부드럽게 나타나게 한다
    const wrap = $('canvas-wrap');
    if (wrap) {
      wrap.classList.remove('resume-fade');
      void wrap.offsetWidth; // 리플로우로 애니메이션 재시작 보장
      wrap.classList.add('resume-fade');
      setTimeout(() => wrap.classList.remove('resume-fade'), 700);
    }
    toast('🔌 다시 연결됐어요 — 경기를 이어서 봅니다');
  }
  function leaveToHome(msg) {
    room = null;
    game = null;
    spectating = false;
    if (msg) homeError.textContent = msg;
    showScreen('home');
  }

  // ── 아이템 UI ─────────────────────────────────────────
  function renderItems() {
    const slots = $('item-slots');
    slots.innerHTML = '';
    game.items.forEach((item, i) => {
      const div = document.createElement('div');
      if (item) {
        div.className = `item-slot gcard gcard-${item.grade}`;
        div.title = `[${gradeLabel(item.grade)}] ${item.desc}`;
        div.innerHTML = `<span class="grade-tag grade-${item.grade}">${gradeLabel(item.grade)}</span>
          <span class="emoji">${item.emoji}</span><span class="label">${item.name}</span>`;
        div.addEventListener('click', () => onItemClick(i));
      } else {
        div.className = 'item-slot used';
        div.innerHTML = `<span class="emoji">✔️</span><span class="label">사용함</span>`;
      }
      slots.appendChild(div);
    });
  }

  // ── 🎁 아이템 소개 (아이템전 시작 직후) ──────────────────
  function showIntro() {
    const modal = $('intro-modal');
    if (!game.introEndsAt) return modal.classList.add('hidden');
    const cards = $('intro-cards');
    cards.innerHTML = '';
    const items = (game.items || []).filter(Boolean);
    if (game.spectator || items.length === 0) {
      $('intro-sub').textContent = '플레이어들이 자기 아이템을 확인하는 중입니다...';
    } else {
      $('intro-sub').textContent = '이번 판에 쓸 수 있는 아이템입니다. 타이밍을 노려 사용하세요!';
      items.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = `intro-card gcard gcard-${item.grade}`;
        div.style.animationDelay = `${0.2 + i * 0.4}s`; // 한 장씩 차례로 공개
        div.innerHTML =
          `<div class="intro-emoji">${item.emoji}</div>` +
          `<div class="intro-name">${item.name}</div>` +
          `<div class="intro-grade grade-${item.grade}">${gradeLabel(item.grade)}</div>` +
          `<div class="intro-desc">${item.desc}</div>`;
        cards.appendChild(div);
      });
    }
    modal.classList.remove('hidden');
  }

  function onItemClick(slotIndex) {
    const item = game.items[slotIndex];
    if (!item) return;
    // 늦게 골인 우승: 의미가 뒤집혀 자신에게 쓰는 게 유리할 수 있으므로 대상 자유 선택(자기 포함)
    if (game.winMode === 'last') {
      openTargetModal(slotIndex, item, true);
    } else if (item.target === 'opponent') {
      openTargetModal(slotIndex, item);
    } else {
      useItem(slotIndex, null);
    }
  }

  function useItem(slotIndex, targetId) {
    socket.emit('game:useItem', { slotIndex, targetId }, (res) => {
      if (res && !res.ok) {
        toast(`⚠️ ${res.error}`);
        return;
      }
      game.items[slotIndex] = null;
      renderItems();
    });
  }

  function openTargetModal(slotIndex, item, includeSelf = false) {
    const finished = new Set(game.finishedRanks.map((f) => f.playerId));
    const targets = [...game.players.values()].filter(
      (p) => (includeSelf || p.id !== myId) && !finished.has(p.id)
    );
    if (targets.length === 0) return toast('⚠️ 사용할 수 있는 대상이 없습니다.');

    // 늦게 골인 우승에서는 나에게 쓰는 게 유리할 수 있음을 안내
    $('target-title').innerHTML =
      game.winMode === 'last'
        ? `${item.emoji} ${item.name} — 누구에게?<br><span class="target-hint">🐢 느려질수록 우승! 방해 아이템은 나에게 쓰면 유리해요</span>`
        : `${item.emoji} ${item.name} — 누구에게 쓸까요?`;
    const list = $('target-list');
    list.innerHTML = '';
    for (const p of targets) {
      const btn = document.createElement('button');
      btn.className = 'btn target-btn' + (p.id === myId ? ' target-self' : '');
      const label = p.id === myId ? `${escapeHtml(p.name)} (나 자신)` : escapeHtml(p.name);
      btn.innerHTML = `<span class="player-dot" style="background:${p.color}"></span>${label}`;
      btn.addEventListener('click', () => {
        $('target-modal').classList.add('hidden');
        useItem(slotIndex, p.id);
      });
      list.appendChild(btn);
    }
    $('target-modal').classList.remove('hidden');
  }

  $('btn-target-cancel').addEventListener('click', () =>
    $('target-modal').classList.add('hidden')
  );

  function toast(msg) {
    const area = $('toast-area');
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = msg;
    area.prepend(div);
    while (area.children.length > 4) area.lastChild.remove();
    setTimeout(() => div.remove(), 4000);
  }

  // ── 게임 캔버스 렌더링 ────────────────────────────────
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const minimap = $('minimap');
  let scale = 1;

  function setupCanvas() {
    // 맵 폭에 맞춰 뷰 폭·캔버스 비율을 조정 (기본 600, 넓은 맵이면 그만큼 넓게)
    VIEW.width = (game.board.world && game.board.world.width) || 600;
    const wrap = document.getElementById('canvas-wrap');
    if (wrap) {
      wrap.style.aspectRatio = `${VIEW.width} / ${VIEW.height}`;
      // 데스크톱: 넓은 맵이어도 사이드 순위판이 화면 밖으로 밀리지 않게 보드 높이를 제한
      if (window.innerWidth > 720) {
        const availW = window.innerWidth - 240 - 44; // 사이드 순위판 + 여백
        const availH = window.innerHeight - 20;
        wrap.style.height =
          Math.max(320, Math.min(availH, availW * (VIEW.height / VIEW.width))) + 'px';
      } else {
        wrap.style.height = '';
      }
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = VIEW.width * dpr;
    canvas.height = VIEW.height * dpr;
    scale = dpr;
    setupMinimapCanvas(minimap, game.board.world.height, game.board.world.width);
  }

  // ── 스냅샷 보간 ───────────────────────────────────────
  // 서버 타임스탬프 기준으로 "약간 과거"를 렌더링한다.
  // 패킷 도착 시각의 지터에 흔들리지 않아 어떤 네트워크에서도 부드럽다.
  const INTERP_DELAY_MS = 60; // 60Hz 스냅샷(16.7ms)의 ~3.5배 버퍼 — 지터에 견디면서 30ms 더 낮은 지연
  const REPLAY_DELAY_MS = 60; // 리플레이 프레임(50ms 간격)용

  /** 현재 렌더링할 서버 시각 */
  function renderTime() {
    if (game.replay) {
      return Date.now() + game.replay.offset - game.replay.startAt - REPLAY_DELAY_MS;
    }
    if (game.clockOffset == null) return 0;
    return performance.now() + game.clockOffset - INTERP_DELAY_MS;
  }

  /** renderT 시각을 감싸는 두 스냅샷 사이를 보간 */
  // 🚀 매 프레임 재사용하는 보간 버퍼·색인 (GC 끊김 방지 — new Map/배열/객체 매프레임 생성 제거)
  const _interpMap = new Map();
  let _interpBuf = [];
  function interpolatedBalls(renderT) {
    const snaps = game.snapshots;
    if (snaps.length === 0) return _EMPTY;
    if (snaps.length === 1) return snaps[0].balls;

    let ai = 0;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].t <= renderT) {
        ai = i;
        break;
      }
    }
    const a = snaps[ai];
    const b = snaps[Math.min(ai + 1, snaps.length - 1)];
    const span = b.t - a.t;
    const alpha = span > 0 ? Math.min(Math.max((renderT - a.t) / span, 0), 1) : 1;

    // 공 매칭 키: 멀티볼은 k(playerId:idx), 리플레이는 p
    // a 스냅샷을 재사용 Map 으로 색인해 매 프레임 O(n²) find 를 O(n) 조회로
    _interpMap.clear();
    for (const x of a.balls) _interpMap.set(x.k || x.p, x);
    const src = b.balls;
    const out = _interpBuf;
    let n = 0;
    for (let i = 0; i < src.length; i++) {
      const bb = src[i];
      let o = out[n];
      if (!o) o = out[n] = {};
      // 식별·플래그 복사 (서버 broadcastSnapshot 의 공 필드와 동기 유지)
      o.k = bb.k; o.p = bb.p; o.i = bb.i;
      o.g = bb.g; o.f = bb.f; o.b = bb.b; o.m = bb.m; o.s = bb.s; o.o = bb.o; o.cl = bb.cl;
      const ab = _interpMap.get(bb.k || bb.p);
      const dx = ab ? bb.x - ab.x : 0;
      const dy = ab ? bb.y - ab.y : 0;
      // 매칭 없음 / 순간이동(굴레·원점·포탈)으로 크게 튀면 보간·트레일 없이 스냅 — 잔상 방지
      if (!ab || dx * dx + dy * dy > 360 * 360) {
        o.x = bb.x; o.y = bb.y; o.px = bb.x; o.py = bb.y;
        o.snap = 1; // 이번 프레임 순간이동 — 카메라 포커스에서 제외(카메라 튐 방지)
      } else {
        o.x = ab.x + dx * alpha;
        o.y = ab.y + dy * alpha;
        o.px = ab.x; // 모션 트레일용 직전 위치
        o.py = ab.y;
        o.snap = 0;
      }
      n++;
    }
    out.length = n; // 이번 프레임 공 개수로 길이만 맞춤 (버퍼 자체는 재사용)
    return out;
  }
  const _EMPTY = [];

  /** 회전 구성요소의 현재 각도 계산용 게임 시간(초) — 공 보간과 '같은 타임라인'으로 맞춘다.
   *  이전엔 최근 두 스냅샷의 속도로 보외했는데, 네트워크 지터로 rate 가 프레임마다
   *  출렁여 회전이 버벅였다. 이제 공과 동일하게 renderT 를 감싸는 두 스냅샷 사이를
   *  같은 alpha 로 보간 → 회전이 공만큼 매끄럽게 흐른다. */
  function gameElapsedSec(renderT) {
    const snaps = game.snapshots;
    if (snaps.length === 0) return 0;
    if (snaps.length === 1) return snaps[0].elapsed / 1000;
    let ai = 0;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].t <= renderT) { ai = i; break; }
    }
    const a = snaps[ai];
    const b = snaps[Math.min(ai + 1, snaps.length - 1)];
    const span = b.t - a.t;
    const alpha = span > 0 ? Math.min(Math.max((renderT - a.t) / span, 0), 1) : 1;
    return (a.elapsed + (b.elapsed - a.elapsed) * alpha) / 1000;
  }

  // ── 아이템 상태 시각화 (과장된 이펙트) ──────────────────
  const EFFECT_META = {
    f: { emoji: '🧊', label: '얼음!', color: '#7fdfff' },
    b: { emoji: '🎈', label: '풍선!', color: '#ff9ecb' },
    g: { emoji: '👻', label: '유령!', color: '#e2e8ff' },
    m: { emoji: '🧲', label: '자석!', color: '#ff6b6b' },
    s: { emoji: '⚡', label: '번개!', color: '#ffe14a' },
    o: { emoji: '🎭', label: '변신!', color: '#c8a6ff' },
  };
  const EFFECT_BITS = [['f', 1], ['b', 2], ['g', 4], ['m', 8], ['s', 16], ['o', 32]];

  /** 아이템 효과가 새로 걸린 순간을 감지해 팝 이펙트를 띄운다 (사용/피격을 확실히 알림)
   *  mine=true(내 공)면 카메라와 무관하게 화면 전체 알림도 띄운다 (내 공이 화면 밖이어도 확실히) */
  function detectEffectPops(b, key, mine) {
    let cur = 0;
    for (const [flag, bit] of EFFECT_BITS) if (b[flag]) cur |= bit;
    const prev = game.fxSeen.get(key) || 0;
    if (cur === prev) return;
    for (const [flag, bit] of EFFECT_BITS) {
      if (cur & bit && !(prev & bit)) {
        const m = EFFECT_META[flag];
        game.fxPops.push({ x: b.x, y: b.y, emoji: m.emoji, label: m.label, color: m.color, start: performance.now() });
        if (mine) game.screenFx = { emoji: m.emoji, label: `내 공 — ${m.label}`, color: m.color, start: performance.now() };
      }
    }
    game.fxSeen.set(key, cur);
  }

  /** 본체 뒤 아우라 — 자석(자기장 링) / 번개(둔화 오라) */
  function drawBallAura(ctx, b, x, y, radius, tNow) {
    if (b.m) {
      const pulse = 0.5 + 0.5 * Math.sin(tNow * 0.013);
      ctx.save();
      ctx.strokeStyle = '#ff6b6b';
      ctx.globalAlpha = 0.25 + 0.4 * pulse;
      ctx.lineWidth = 2;
      for (let i = 1; i <= 2; i++) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 5 * i + pulse * 4, -0.25, Math.PI + 0.25);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (b.s) {
      ctx.save();
      ctx.globalAlpha = 0.28 + 0.18 * Math.sin(tNow * 0.02);
      ctx.fillStyle = '#4a7fc1';
      ctx.beginPath();
      ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /** 🎭 변신 도형 경로 (1=삼각 2=사각 3=오각 4=육각 5=별). beginPath 포함 */
  function morphPath(ctx, x, y, r, shape, rot) {
    ctx.beginPath();
    if (shape === 5) {
      // 5각 별
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 === 0 ? r : r * 0.46;
        const a = rot + (i / 10) * Math.PI * 2 - Math.PI / 2;
        const px = x + Math.cos(a) * rr;
        const py = y + Math.sin(a) * rr;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
    } else {
      const sides = [3, 4, 5, 6][(shape - 1) % 4];
      for (let i = 0; i < sides; i++) {
        const a = rot + (i / sides) * Math.PI * 2 - Math.PI / 2;
        const px = x + Math.cos(a) * r;
        const py = y + Math.sin(a) * r;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
    }
    ctx.closePath();
  }

  /** 본체 위 오버레이 — 얼음 결정 / 풍선 끈 / 상태 이모지 */
  function drawBallEffects(ctx, b, x, y, radius, tNow) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (b.f) {
      // 꽝꽝 언 육각 얼음 결정 + 서리 스파이크 + 반짝임
      const R = radius + 6;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        const px = x + Math.cos(a) * R;
        const py = y + Math.sin(a) * R;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(150,225,255,0.34)';
      ctx.fill();
      ctx.strokeStyle = '#dff4ff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(223,244,255,0.85)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 2 + 0.5;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
        ctx.lineTo(x + Math.cos(a) * (R + 3), y + Math.sin(a) * (R + 3));
        ctx.stroke();
      }
      const tw = 0.5 + 0.5 * Math.sin(tNow * 0.02 + x);
      ctx.globalAlpha = tw;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x + radius * 0.4, y - radius * 0.5, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (b.b) {
      // 풍선 끈
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y + radius);
      ctx.quadraticCurveTo(x + 4, y + radius + 8, x, y + radius + 14);
      ctx.stroke();
    }
    ctx.font = '12px sans-serif';
    if (b.g) ctx.fillText('👻', x, y);
    if (b.m) ctx.fillText('🧲', x, y - radius - 9);
    if (b.s) ctx.fillText('⚡', x, y - radius - 9);
    ctx.restore();
  }

  function renderFrame() {
    if (!game) return;

    // ── 이벤트 리플레이: 재생 시각에 맞춰 프레임/이벤트 공급 ──
    if (game.replay) {
      const rp = game.replay;
      const playT = Date.now() + rp.offset - rp.startAt;
      if (playT < 0) {
        $('countdown').textContent = `추첨 시작 ${Math.ceil(-playT / 1000)}초 전`;
      } else {
        $('countdown').textContent = '';
        while (rp.fi < rp.frames.length && rp.frames[rp.fi].t <= playT) {
          const f = rp.frames[rp.fi++];
          game.snapshots.push({
            t: f.t, // 재생(실제) 시간축
            elapsed: f.e !== undefined ? f.e : f.t, // 게임 시간 (회전체 각도용)
            countdown: 0,
            balls: f.b.map(([p, x, y, fl]) => ({
              p,
              x,
              y,
              g: fl & 1 ? 1 : 0,
              f: fl & 2 ? 1 : 0,
              b: fl & 4 ? 1 : 0,
              o: fl & 8 ? ((p % 5) + 1) : 0, // 🎭 변신 — 도형은 참가번호로 유도(재생에도 다양하게)
            })),
          });
          if (game.snapshots.length > 12) game.snapshots.shift();
          updateHiddenComps(f.off);
        }
        while (rp.ei < rp.events.length && rp.events[rp.ei].t <= playT) {
          dispatchReplayEvent(rp.events[rp.ei++]);
        }
        if (playT > rp.durationMs + 1500 && !game.overShown) {
          game.overShown = true;
          showResults(rp.ranking, { event: true });
        }
      }
    }

    const { board } = game;
    const renderT = renderTime();
    const balls = interpolatedBalls(renderT);
    const elapsed = gameElapsedSec(renderT);

    // 프레임 간 실제 경과시간 — 카메라 감쇠를 화면 주사율과 무관하게(60·120·144Hz 동일 체감)
    const nowFrame = performance.now();
    const dtMs = game._lastFrameMs ? Math.min(64, nowFrame - game._lastFrameMs) : 16.7;
    game._lastFrameMs = nowFrame;

    // 카메라: 골인에 가장 가까운(최대 y) 공을 따라간다 — 경주의 최전선을 비춘다.
    // 순간이동(포탈·굴레) 공과 분신(clone)은 포커스에서 제외해 카메라가 튀지 않게 하고,
    // 근소한 순위 뒤집힘엔 기존 포커스를 유지(히스테리시스)해 1프레임 흔들림을 막는다.
    const mapH = board.world.height;
    let best = null;
    let prevFocus = null;
    for (const b of balls) {
      if (b.cl || b.snap) continue;
      if (!best || b.y > best.y) best = b;
      if (game._focusKey != null && (b.k || b.p) === game._focusKey) prevFocus = b;
    }
    let focus = best;
    if (prevFocus && best && best.y - prevFocus.y < 60) focus = prevFocus; // 근소한 차이면 유지
    if (focus) {
      game._focusKey = focus.k != null ? focus.k : focus.p;
      const target = clampCam(focus.y - VIEW.height * 0.42, mapH);
      // 프레임레이트 독립 감쇠 (60fps에서 0.22와 동일한 체감)
      const k = 1 - Math.pow(1 - 0.22, dtMs / 16.7);
      game.camY += (target - game.camY) * k;
      // 빠른 공에도 뒤처지지 않도록 하드 클램프 (앞 130 / 뒤 320px)
      if (target - game.camY > 130) game.camY = target - 130;
      else if (game.camY - target > 320) game.camY = target + 320;
    }
    const camY = game.camY;

    // 폭발 시 카메라 흔들림
    let shakeX = 0;
    let shakeY = 0;
    if (game.shakeUntil > performance.now()) {
      const m = (5 * (game.shakeUntil - performance.now())) / 250;
      shakeX = (Math.random() - 0.5) * m * 2;
      shakeY = (Math.random() - 0.5) * m * 2;
    }

    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, VIEW.width, VIEW.height);
    ctx.save();
    ctx.translate(shakeX, -camY + shakeY);

    drawBoardDecor(ctx, board);
    drawGoal(ctx, board.goal);

    // 맵 구성요소 (화면 근처만 그리기, 회전체·이동체는 경과 시간으로 계산 → 서버와 동기화)
    for (let i = 0; i < board.components.length; i++) {
      const comp = board.components[i];
      if (game.hiddenComps.has(i)) continue; // 터진 폭탄 등은 재생성까지 숨김
      if (comp.y < camY - 300 || comp.y > camY + VIEW.height + 300) continue;
      let ox = 0;
      let oy = 0;
      if (comp.move) {
        const off = Math.sin(elapsed * comp.move.speed) * comp.move.range;
        if (comp.move.axis === 'y') oy = off;
        else ox = off;
      }
      drawComponent(ctx, comp, comp.spin ? comp.spin * elapsed : 0, false, ox, oy);
    }

    // 🌀 블랙홀 흡입 범위 (공보다 먼저 그려 공이 위로 빨려드는 느낌을 살린다)
    {
      const nowB = performance.now();
      if (game.blackholes.length) game.blackholes = game.blackholes.filter((bh) => nowB - bh.start < bh.duration);
      for (const bh of game.blackholes) {
        const bt = (nowB - bh.start) / bh.duration; // 0..1
        const R = bh.radius;
        ctx.save();
        // 인력장 (안쪽으로 갈수록 어두운 보라)
        const grad = ctx.createRadialGradient(bh.x, bh.y, 0, bh.x, bh.y, R);
        grad.addColorStop(0, 'rgba(18,6,36,0.6)');
        grad.addColorStop(0.55, 'rgba(90,40,160,0.26)');
        grad.addColorStop(1, 'rgba(90,40,160,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(bh.x, bh.y, R, 0, Math.PI * 2);
        ctx.fill();
        // 범위 경계 링 (전설 보라)
        ctx.globalAlpha = 0.55 * (1 - bt) + 0.25;
        ctx.strokeStyle = '#b96bff';
        ctx.shadowColor = '#b96bff';
        ctx.shadowBlur = 14;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(bh.x, bh.y, R, 0, Math.PI * 2);
        ctx.stroke();
        // 빨려드는 소용돌이 팔 (회전)
        const rot = nowB / 240;
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = '#d9b3ff';
        ctx.lineWidth = 2.4;
        ctx.shadowBlur = 8;
        for (let arm = 0; arm < 3; arm++) {
          ctx.beginPath();
          for (let s = 0; s <= 1.0001; s += 0.05) {
            const ang = rot + arm * ((Math.PI * 2) / 3) + s * 6;
            const rr = R * (1 - s);
            const px = bh.x + Math.cos(ang) * rr;
            const py = bh.y + Math.sin(ang) * rr;
            if (s === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        // 중심 특이점
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 22;
        ctx.fillStyle = '#08040f';
        ctx.beginPath();
        ctx.arc(bh.x, bh.y, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // 공 (인원이 많으면 그림자/이름표 생략 — 선두와 내 공만 이름표)
    const r = board.ballRadius;
    const many = game.players.size > 30;
    const mineKey = game.replay ? myParticipantId : myId;
    const focusKey = focus ? focus.p : null;
    const tNow = performance.now();
    for (const b of balls) {
      const p = game.players.get(b.p);
      const color = p ? p.color : '#888';

      // ✨ 분신(clone): 반투명한 잔상 구슬로만 표시 (이름표·이펙트·트레일 없음)
      if (b.cl) {
        ctx.save();
        ctx.globalAlpha = 0.42;
        ctx.shadowColor = color;
        ctx.shadowBlur = 9;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, r * 0.92, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        continue;
      }

      const radius = b.b ? r * 1.6 : r;
      const key = b.k || b.p + ':' + (b.i || 0);

      // 아이템 발동 순간 감지 → 팝 이펙트 (내가 쓰거나 당했을 때 확실히 보이게)
      detectEffectPops(b, key, b.p === mineKey);

      // 화면 밖 공은 그리지 않는다 — 500명 이벤트에서 대부분의 공은 카메라 밖이라 큰 절약
      if (b.y < camY - 80 || b.y > camY + VIEW.height + 80) continue;

      // 🧊 얼음: 으슬으슬 떠는 지터 / 🎈 풍선: 말랑말랑 흔들림
      const ph = key.length + (b.i || 0) * 3;
      let bx = b.x;
      let by = b.y;
      if (b.f) {
        bx += Math.sin(tNow * 0.045 + ph) * 1.7 + Math.sin(tNow * 0.13 + ph) * 1.1;
        by += Math.cos(tNow * 0.05 + ph) * 1.4 + Math.sin(tNow * 0.17 + ph) * 0.8;
      }
      let rx = radius;
      let ry = radius;
      if (b.b) {
        const wob = Math.sin(tNow * 0.011 + ph) * 0.16;
        rx = radius * (1 + wob);
        ry = radius * (1 - wob);
      }

      ctx.save();
      if (b.g) ctx.globalAlpha = 0.4; // 유령 상태

      // 모션 트레일 (속도가 빠를수록 길게)
      if (b.px !== undefined && !game.shuffling) {
        const dx = b.x - b.px;
        const dy = b.y - b.py;
        const speed = Math.hypot(dx, dy);
        if (speed > 2) {
          const len = Math.min(speed * 2.2, radius * 4);
          ctx.strokeStyle = color;
          ctx.globalAlpha = (b.g ? 0.4 : 1) * 0.22;
          ctx.lineWidth = radius * 1.5;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(bx - (dx / speed) * len, by - (dy / speed) * len);
          ctx.lineTo(bx, by);
          ctx.stroke();
          ctx.globalAlpha = b.g ? 0.4 : 1;
        }
      }

      // 지속형 아이템 아우라(본체 뒤) — 자석/번개
      drawBallAura(ctx, b, bx, by, radius, tNow);

      // 본체 — 발광 구슬 (풍선이면 타원으로 말랑 / 🎭 변신이면 각진 도형이 빙글 회전)
      const morphed = b.o > 0;
      const morphRot = tNow * 0.006 + ph;
      ctx.shadowColor = color;
      ctx.shadowBlur = b.b ? 16 : morphed ? 14 : 11;
      ctx.fillStyle = color;
      if (morphed) {
        morphPath(ctx, bx, by, radius * 1.28, b.o, morphRot);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      // 밝은 코어 (변신 중엔 생략해 각진 실루엣을 살림)
      if (!morphed) {
        ctx.beginPath();
        ctx.arc(bx - radius * 0.2, by - radius * 0.24, radius * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.fill();
      }

      // 내 공은 금테로 표시 (도형이면 도형 외곽선)
      if (b.p === mineKey) {
        ctx.strokeStyle = 'rgba(212,175,55,0.9)';
        ctx.lineWidth = 1.5;
        if (morphed) {
          morphPath(ctx, bx, by, radius * 1.28, b.o, morphRot);
        } else {
          ctx.beginPath();
          ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI * 2);
        }
        ctx.stroke();
      }
      ctx.restore();

      // 과장된 상태 오버레이 (얼음 결정/풍선 끈/상태 이모지)
      drawBallEffects(ctx, b, bx, by, radius, tNow);

      // 이름표 (후원자는 💖, 멀티볼은 번호 표기)
      const showLabel = !many || b.p === mineKey || b.p === focusKey;
      if (showLabel) {
        const idxTag = game.ballsPer > 1 && b.i !== undefined ? `·${b.i + 1}` : '';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.textAlign = 'center';
        ctx.fillText(
          (p && p.isDonor ? '💖' : '') +
            (p ? p.name : '?') +
            idxTag +
            (b.p === mineKey ? ' ★' : ''),
          b.x,
          b.y - radius - 6
        );
      }
    }

    // 폭발 이펙트 (확장 링 + 화염 + 파편)
    const nowMs = performance.now();
    if (game.explosions.length) game.explosions = game.explosions.filter((ex) => nowMs - ex.start < 600);
    for (const ex of game.explosions) {
      const t = (nowMs - ex.start) / 600;
      const ease = 1 - Math.pow(1 - t, 3);
      const r = ex.radius * (0.25 + 0.75 * ease);
      ctx.save();
      if (!ex.color) {
        ctx.globalAlpha = (1 - t) * 0.35;
        ctx.fillStyle = '#ff7a3a';
        ctx.beginPath();
        ctx.arc(ex.x, ex.y, r * 0.65, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = ex.color || '#ffb03a';
      ctx.shadowColor = ex.color || '#ffb03a';
      ctx.shadowBlur = ex.color ? 12 : 0;
      ctx.lineWidth = 5 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2);
      ctx.stroke();
      if (!ex.color) {
        ctx.fillStyle = '#ffd76a';
        for (let i = 0; i < 8; i++) {
          const a = (Math.PI * 2 * i) / 8 + 0.4;
          ctx.beginPath();
          ctx.arc(ex.x + Math.cos(a) * r, ex.y + Math.sin(a) * r, 3.5 * (1 - t) + 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // 🎉 우승 축포 컨페티 (골인 지점, 월드 좌표)
    const CELEB_LIFE = 1900;
    if (game.celebrations.length) game.celebrations = game.celebrations.filter((c) => nowMs - c.start < CELEB_LIFE);
    for (const c of game.celebrations) {
      const age = nowMs - c.start;
      // 초반 섬광 링 ("펑!")
      if (age < 420) {
        const ft = age / 420;
        ctx.save();
        ctx.globalAlpha = (1 - ft) * 0.9;
        ctx.strokeStyle = '#fff3b0';
        ctx.shadowColor = '#ffd12e';
        ctx.shadowBlur = 20;
        ctx.lineWidth = 6 * (1 - ft) + 1;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 20 + ft * 90, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      // 컨페티 조각
      for (const p of c.particles) {
        const px = c.x + Math.cos(p.a) * p.s * age;
        const py = c.y + Math.sin(p.a) * p.s * age + 0.00028 * age * age; // 중력
        const alpha = age < CELEB_LIFE - 500 ? 1 : 1 - (age - (CELEB_LIFE - 500)) / 500;
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha);
        ctx.translate(px, py);
        ctx.rotate(p.rot + p.rotSpeed * age);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
    }

    // ✨ 아이템 발동 순간 팝 (떠오르는 이모지 + 팽창 링 + 라벨) — 월드 좌표
    const POP_LIFE = 950;
    if (game.fxPops.length) game.fxPops = game.fxPops.filter((f) => nowMs - f.start < POP_LIFE);
    for (const f of game.fxPops) {
      const t = (nowMs - f.start) / POP_LIFE;
      const yy = f.y - t * 26;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 3 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(f.x, f.y, 8 + t * 32, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1 - t * t;
      ctx.font = `${16 + (1 - t) * 9}px sans-serif`;
      ctx.fillText(f.emoji, f.x, yy - 6);
      ctx.fillStyle = f.color;
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(f.label, f.x, yy + 12);
      ctx.restore();
    }

    ctx.restore();

    // 🔔 내 공이 아이템에 걸린 순간 화면 전체 알림 (카메라 밖이어도 확실히 알림)
    if (game.screenFx) {
      const age = nowMs - game.screenFx.start;
      const DUR = 1200;
      if (age > DUR) {
        game.screenFx = null;
      } else {
        const t = age / DUR;
        ctx.save();
        // 가장자리 색 비네트 플래시
        const cxv = VIEW.width / 2;
        const cyv = VIEW.height / 2;
        const grad = ctx.createRadialGradient(cxv, cyv, VIEW.height * 0.28, cxv, cyv, VIEW.height * 0.75);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, game.screenFx.color);
        ctx.globalAlpha = (1 - t) * 0.5;
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, VIEW.width, VIEW.height);
        // 중앙 배너 (이모지 + 라벨)
        const pop = t < 0.18 ? t / 0.18 : 1;
        ctx.globalAlpha = Math.min(1, (1 - t) * 1.7);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.font = `${32 + pop * 10}px sans-serif`;
        ctx.fillText(game.screenFx.emoji, cxv, VIEW.height * 0.32);
        ctx.fillStyle = game.screenFx.color;
        ctx.font = 'bold 22px sans-serif';
        ctx.fillText(game.screenFx.label, cxv, VIEW.height * 0.32 + 36);
        ctx.restore();
      }
    }

    // 미니맵
    drawMinimap(minimap, {
      width: board.world.width,
      height: mapH,
      components: board.components,
      hidden: game.hiddenComps,
      hiddenV: game.hiddenVersion,
      explosions: game.explosions,
      balls, // 보간 결과를 그대로 전달 (색·본인 여부는 drawMinimap 이 해석)
      players: game.players,
      selfId: myId,
      camY,
      elapsed,
    });

    // 상태 표시 + 방장 낙하 버튼 (리플레이는 위에서 자체 표시)
    if (!game.replay) {
      if (game.shuffling) {
        const introLeft = game.introEndsAt ? game.introEndsAt - performance.now() : 0;
        if (introLeft > 0) {
          // 아이템 소개 중 — 서버도 셔플·낙하를 멈춰 두고 있다
          const sec = Math.ceil(introLeft / 1000);
          $('countdown').textContent = `🎁 아이템 확인 시간! (${sec}초)`;
          $('intro-count').textContent = `${sec}초 후 자리 섞기 시작!`;
          $('btn-drop').classList.add('hidden');
          // 최초 showIntro 가 어떤 이유로든 놓쳐졌으면(모바일 탭 지연 등) 다시 띄운다
          if ($('intro-modal').classList.contains('hidden')) showIntro();
        } else {
          if (game.introEndsAt) {
            game.introEndsAt = 0;
            $('intro-modal').classList.add('hidden');
            toast('🎲 자리 섞기 시작!');
          }
          const isHost = !game.autoPilot && room && room.hostId === myId;
          $('countdown').textContent = game.autoPilot
            ? '🎲 운명이 배치를 정하는 중...'
            : isHost
              ? '🎲 타이밍을 노리세요!'
              : '🎲 위치 섞는 중...';
          $('btn-drop').classList.toggle('hidden', !isHost);
        }
      } else {
        // 셔플이 끝났으면(낙하 시작) 남아있을 수 있는 소개 모달을 확실히 닫는다
        if (game.introEndsAt) {
          game.introEndsAt = 0;
          $('intro-modal').classList.add('hidden');
        }
        $('countdown').textContent = game.snapshots.length ? '' : '준비...';
        $('btn-drop').classList.add('hidden');
      }
    } else {
      $('btn-drop').classList.add('hidden');
    }

    requestAnimationFrame(renderFrame);
  }

  // ── 맵 에디터 ─────────────────────────────────────────
  const editor = {
    active: false,
    comps: [], // [{type, x, y, props, shapes, spin}]
    tool: 'peg', // 팔레트에서 선택된 구성요소 타입
    selected: -1, // 선택된 comps 인덱스
    selFinish: false, // 🏁 골인 존을 선택 중인가
    dragging: false,
    camY: 0,
    height: WORLD.height, // 이 맵의 길이 (슬라이더로 조절)
    width: WORLD.width, // 이 맵의 폭 (슬라이더로 조절)
    finish: null, // 🏁 골인 존 {x,y,width,height}
  };

  const editMaxY = () => editor.height - 100;
  const editMaxX = () => editor.width - EDIT_BOUNDS.minX;

  const eCanvas = $('editor-canvas');
  const eCtx = eCanvas.getContext('2d');
  const eMinimap = $('editor-minimap');
  let eScale = 1;

  function setupEditorCanvas() {
    // 맵 폭에 맞춰 뷰 폭·캔버스 비율 조정
    VIEW.width = editor.width || WORLD.width;
    const wrap = document.getElementById('editor-wrap');
    if (wrap) {
      wrap.style.aspectRatio = `${VIEW.width} / ${VIEW.height}`;
      // 데스크톱: 폭이 넓어도 사이드 패널이 화면 밖으로 밀리지 않게 보드 높이를 제한
      if (window.innerWidth > 720) {
        const availW = window.innerWidth - 104 - 260 - 48; // 미니맵자리 + 사이드 + 여백
        const availH = window.innerHeight - 20;
        wrap.style.height =
          Math.max(320, Math.min(availH, availW * (VIEW.height / VIEW.width))) + 'px';
      } else {
        wrap.style.height = ''; // 모바일은 CSS(46vh)에 맡김
      }
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    eCanvas.width = VIEW.width * dpr;
    eCanvas.height = VIEW.height * dpr;
    eScale = dpr;
    setupMinimapCanvas(eMinimap, editor.height, editor.width);
  }

  function rebuildComp(comp) {
    const built = buildShapes(comp.type, comp.props);
    if (!built) return false; // 알 수 없는(제거된) 구성요소 타입 — 건너뛰게 한다
    comp.shapes = built.shapes;
    comp.spin = built.spin;
    comp.hit = built.hit || null;
    comp.move = built.move || null;
    return true;
  }

  /**
   * 에디터 열기.
   * @param {object} opts.viewOnly  true면 읽기 전용 "맵 구경" 모드
   * @param {object} opts.map       불러올 맵 정의 {name, author, height, components}
   * @param {string} opts.from      돌아갈 화면 ('maps' 등)
   */
  function openEditor(opts = {}) {
    editor.viewOnly = !!opts.viewOnly;
    editor.from = opts.from || 'maps';
    editor.adminEditId = opts.adminEditId || null; // 관리자 재편집 대상 맵 id
    editor.comps = [];
    editor.selected = -1;
    editor.selFinish = false;
    editor.tool = 'peg';
    editor.camY = 0;
    editor.height = opts.map ? opts.map.height : WORLD.height;
    editor.width = (opts.map && opts.map.width) || WORLD.width;
    // 🏁 골인 존: 불러온 맵에 있으면 그대로, 없으면 기본(바닥 중앙)
    editor.finish = clampFinish(opts.map && opts.map.finish, editor.height, editor.width);

    // 맵 불러오기 (구경 모드) — 알 수 없는(제거된) 타입 요소는 건너뛴다
    if (opts.map) {
      for (const c of opts.map.components) {
        const comp = { type: c.type, x: c.x, y: c.y, props: { ...c.props } };
        if (rebuildComp(comp)) editor.comps.push(comp);
      }
    }

    // 편집 컨트롤 표시/숨김
    const editControls = ['palette', 'editor-props', 'btn-comp-delete', 'input-map-name', 'btn-map-save', 'map-length-row', 'map-width-row', 'editor-hint'];
    for (const id of editControls) {
      $(id).style.display = editor.viewOnly ? 'none' : '';
    }
    $('editor-title').textContent = editor.viewOnly
      ? `👁 「${opts.map ? opts.map.name : '맵'}」 구경`
      : editor.adminEditId
        ? '🔧 관리자 맵 편집'
        : '🛠 맵 에디터';
    // 라벨은 전 화면 통일 (← 돌아가기). 실제 이동 대상은 from 값으로 결정된다.
    $('btn-editor-back').textContent = '← 돌아가기';

    $('input-map-length').value = editor.height;
    $('map-length-label').textContent = `📐 맵 길이: ${editor.height}`;
    $('input-map-width').value = editor.width;
    $('map-width-label').textContent = `📏 맵 폭: ${editor.width}`;
    $('input-map-name').value = opts.adminEditName || '';
    $('btn-map-save').textContent = editor.adminEditId ? '💾 관리자 저장(덮어쓰기)' : '💾 저장하고 공유하기';
    $('editor-msg').textContent = '';
    if (!editor.viewOnly) {
      renderPalette();
      renderPropsPanel();
    }
    showScreen('editor'); // 화면 표시 후에 캔버스 크기 계산
    setupEditorCanvas();
  }

  // 맵 길이 슬라이더: 줄이면 범위를 벗어난 구성요소를 안쪽으로 이동
  $('input-map-length').addEventListener('input', (e) => {
    editor.height = Number(e.target.value);
    $('map-length-label').textContent = `📐 맵 길이: ${editor.height}`;
    for (const comp of editor.comps) {
      if (comp.y > editMaxY()) comp.y = editMaxY();
    }
    // 🏁 골인 존도 새 길이에 맞춰 안전 범위로 보정
    if (editor.finish) editor.finish = clampFinish(editor.finish, editor.height, editor.width);
    editor.camY = clampCam(editor.camY, editor.height);
    setupMinimapCanvas(eMinimap, editor.height, editor.width);
  });

  // 맵 폭 슬라이더: 폭이 바뀌면 캔버스 비율을 다시 잡고, 범위를 벗어난 요소를 안쪽으로
  $('input-map-width').addEventListener('input', (e) => {
    editor.width = Number(e.target.value);
    $('map-width-label').textContent = `📏 맵 폭: ${editor.width}`;
    for (const comp of editor.comps) {
      if (comp.x > editMaxX()) comp.x = editMaxX();
    }
    if (editor.finish) editor.finish = clampFinish(editor.finish, editor.height, editor.width);
    setupEditorCanvas(); // 뷰 폭·비율·미니맵 재설정
  });

  $('btn-editor-back').addEventListener('click', () => {
    if (editor.from === 'admin') {
      showScreen('admin');
      loadAdmin();
    } else if (editor.from === 'maps') {
      renderMapsGallery();
      showScreen('maps');
    } else if (room) {
      renderLobby();
      showScreen('lobby');
    } else {
      showScreen('home');
    }
  });

  // 팔레트 아이콘: 이모지 대신 '실제 배치되는 모양'을 작은 캔버스로 그려 보여준다
  // (회전 막대·포탈·점프 패드 등이 서로 확실히 구분되도록)
  function paletteIcon(def) {
    const built = buildShapes(def.id, defaultProps(def));
    const comp = { type: def.id, x: 0, y: 0, shapes: built.shapes, spin: built.spin };
    let rad = 8;
    for (const s of built.shapes) {
      const off = Math.hypot(s.x, s.y);
      rad = Math.max(rad, off + (s.kind === 'circle' ? s.r : Math.max(s.w, s.h) / 2));
    }
    const size = 34;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = document.createElement('canvas');
    c.className = 'palette-icon';
    c.width = c.height = size * dpr;
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.translate(size / 2, size / 2);
    ctx.scale((size / 2 - 4) / rad, (size / 2 - 4) / rad); // 여백 두고 맞춤
    drawComponent(ctx, comp, 0);
    return c;
  }

  function renderPalette() {
    const palette = $('palette');
    palette.innerHTML = '';
    for (const def of Object.values(COMPONENTS)) {
      const btn = document.createElement('button');
      btn.className = 'palette-btn' + (editor.tool === def.id ? ' selected' : '');
      btn.title = def.desc;
      btn.appendChild(paletteIcon(def));
      const label = document.createElement('span');
      label.className = 'palette-label';
      label.textContent = def.name;
      btn.appendChild(label);
      btn.addEventListener('click', () => {
        editor.tool = def.id;
        editor.selected = -1;
        editor.selFinish = false;
        renderPalette();
        renderPropsPanel();
      });
      palette.appendChild(btn);
    }
  }

  /** 선택된 구성요소의 속성 슬라이더 */
  function renderPropsPanel() {
    const panel = $('editor-props');
    panel.innerHTML = '';
    $('btn-comp-delete').disabled = editor.selected < 0;

    // 🏁 골인 존 선택 시: 폭/높이 슬라이더 (위치는 드래그로 이동)
    if (editor.selFinish && editor.finish) {
      const f = editor.finish;
      const title = document.createElement('div');
      title.className = 'prop-row';
      title.innerHTML = '선택됨: 🏁 <b>골인(FINISH)</b><br><span class="hint" style="font-size:11px">드래그해서 위치 이동 · 아래 슬라이더로 크기 조절</span>';
      panel.appendChild(title);
      const addSlider = (label, key, min, max, step) => {
        const row = document.createElement('div');
        row.className = 'prop-row';
        const lab = document.createElement('span');
        const input = document.createElement('input');
        input.type = 'range';
        input.min = min;
        input.max = max;
        input.step = step;
        input.value = f[key];
        const setLabel = () => (lab.textContent = `${label}: ${input.value}`);
        setLabel();
        input.addEventListener('input', () => {
          f[key] = Number(input.value);
          // 폭이 커지면 x가 벽을 넘지 않도록 보정
          const half = f.width / 2;
          f.x = Math.min(Math.max(f.x, half), editor.width - half);
          setLabel();
        });
        row.appendChild(lab);
        row.appendChild(input);
        panel.appendChild(row);
      };
      addSlider('폭(가로)', 'width', FINISH.minW, FINISH.maxW, 2);
      addSlider('높이(세로)', 'height', FINISH.minH, FINISH.maxH, 2);
      return;
    }

    const comp = editor.comps[editor.selected];
    if (!comp) {
      const def = COMPONENTS[editor.tool];
      panel.innerHTML = `<div class="prop-row">배치할 요소: ${def.emoji} ${def.name}<br>${def.desc}</div>
        <div class="prop-row" style="margin-top:6px">🏁 <b>골인</b>은 화면 하단의 체커 존을 <b>드래그</b>해 옮기거나, 눌러서 크기를 조절하세요.</div>`;
      return;
    }
    const def = COMPONENTS[comp.type];
    const title = document.createElement('div');
    title.className = 'prop-row';
    title.textContent = `선택됨: ${def.emoji} ${def.name}`;
    panel.appendChild(title);

    for (const schema of def.props) {
      const row = document.createElement('div');
      row.className = 'prop-row';
      const label = document.createElement('span');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = schema.min;
      input.max = schema.max;
      input.step = schema.step;
      input.value = comp.props[schema.key];
      const setLabel = () => {
        let extra = '';
        // 회전 속도는 부호로 방향이 정해지므로 시계/반시계를 명확히 표시
        if (schema.key === 'speed') {
          const v = Number(input.value);
          extra = v > 0 ? '  ↻ 시계방향' : v < 0 ? '  ↺ 반시계방향' : '  (정지)';
        }
        label.textContent = `${schema.label}: ${input.value}${extra}`;
      };
      setLabel();
      input.addEventListener('input', () => {
        comp.props[schema.key] = Number(input.value);
        rebuildComp(comp);
        setLabel();
      });
      row.appendChild(label);
      row.appendChild(input);
      panel.appendChild(row);
    }
  }

  // 캔버스 좌표 변환 (에디터 카메라 반영)
  function eventToWorld(e) {
    const rect = eCanvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * VIEW.width,
      y: ((e.clientY - rect.top) / rect.height) * VIEW.height + editor.camY,
    };
  }

  function clampToBounds(pos) {
    return {
      x: Math.round(Math.min(Math.max(pos.x, EDIT_BOUNDS.minX), editMaxX()) / 5) * 5,
      y: Math.round(Math.min(Math.max(pos.y, EDIT_BOUNDS.minY), editMaxY()) / 5) * 5,
    };
  }

  /** 🏁 골인 존을 클릭했는가 */
  function finishHitTest(pos) {
    const f = editor.finish;
    if (!f) return false;
    const half = f.width / 2;
    return (
      pos.x >= f.x - half &&
      pos.x <= f.x + half &&
      pos.y >= f.y - 12 &&
      pos.y <= f.y + f.height + 12
    );
  }

  /** 골인 존을 드래그 위치로 이동 (범위·격자 보정) */
  function moveFinish(pos) {
    const f = editor.finish;
    const half = f.width / 2;
    f.x = Math.round(Math.min(Math.max(pos.x, half), editor.width - half) / 5) * 5;
    // 골인은 맵 하단까지 내려갈 수 있다 (바닥에서 조금 위까지)
    f.y = Math.round(Math.min(Math.max(pos.y, EDIT_BOUNDS.minY + 40), editor.height - 30) / 5) * 5;
  }

  /** 클릭 지점의 구성요소 인덱스 (겹치면 나중에 놓은 것 우선) */
  /** 점이 실제 도형(원/사각, 회전 반영) 위에 있는가 — 약간의 여유(tol)만 허용 */
  function pointInShape(px, py, cx, cy, s, tol = 6) {
    const sx = cx + (s.x || 0);
    const sy = cy + (s.y || 0);
    if (s.kind === 'circle') return Math.hypot(px - sx, py - sy) <= s.r + tol;
    // 사각형: 클릭점을 도형 로컬 좌표로 회전 변환해 안쪽인지 검사
    const a = -(s.angle || 0);
    const dx = px - sx;
    const dy = py - sy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    return Math.abs(lx) <= s.w / 2 + tol && Math.abs(ly) <= s.h / 2 + tol;
  }

  // 실제 도형 위를 클릭했을 때만 선택 (긴 막대가 근처 오브젝트 선택을 가리지 않도록)
  function hitTest(pos) {
    for (let i = editor.comps.length - 1; i >= 0; i--) {
      const comp = editor.comps[i];
      for (const s of comp.shapes) {
        if (pointInShape(pos.x, pos.y, comp.x, comp.y, s)) return i;
      }
    }
    return -1;
  }

  eCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (editor.viewOnly) return; // 구경 모드: 스크롤만 가능
    const pos = eventToWorld(e);
    const hit = hitTest(pos);
    if (hit >= 0) {
      editor.selected = hit;
      editor.selFinish = false;
      editor.dragging = true;
    } else if (finishHitTest(pos)) {
      // 🏁 골인 존 선택/이동
      editor.selFinish = true;
      editor.selected = -1;
      editor.dragging = true;
      moveFinish(pos);
    } else {
      // 새 구성요소 배치
      const def = COMPONENTS[editor.tool];
      const comp = {
        type: def.id,
        ...clampToBounds(pos),
        props: defaultProps(def),
      };
      rebuildComp(comp);
      editor.comps.push(comp);
      editor.selected = editor.comps.length - 1;
      editor.selFinish = false;
      editor.dragging = true;
    }
    renderPropsPanel();
    eCanvas.setPointerCapture(e.pointerId);
  });

  eCanvas.addEventListener('pointermove', (e) => {
    if (!editor.dragging) return;
    if (editor.selFinish) {
      moveFinish(eventToWorld(e));
      return;
    }
    if (editor.selected < 0) return;
    const comp = editor.comps[editor.selected];
    Object.assign(comp, clampToBounds(eventToWorld(e)));
  });

  eCanvas.addEventListener('pointerup', () => {
    editor.dragging = false;
  });

  // 휠 스크롤로 긴 맵 이동
  eCanvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      editor.camY = clampCam(editor.camY + e.deltaY, editor.height);
    },
    { passive: false }
  );

  // 에디터 미니맵: 클릭/드래그로 화면 이동
  function minimapJump(e) {
    const rect = eMinimap.getBoundingClientRect();
    const worldY = ((e.clientY - rect.top) / rect.height) * editor.height;
    editor.camY = clampCam(worldY - VIEW.height / 2, editor.height);
  }
  eMinimap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    minimapJump(e);
    eMinimap.setPointerCapture(e.pointerId);
    const move = (ev) => minimapJump(ev);
    const up = () => {
      eMinimap.removeEventListener('pointermove', move);
      eMinimap.removeEventListener('pointerup', up);
    };
    eMinimap.addEventListener('pointermove', move);
    eMinimap.addEventListener('pointerup', up);
  });

  function deleteSelected() {
    if (editor.selected < 0) return;
    editor.comps.splice(editor.selected, 1);
    editor.selected = -1;
    renderPropsPanel();
  }

  $('btn-comp-delete').addEventListener('click', deleteSelected);
  document.addEventListener('keydown', (e) => {
    if (!editor.active) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if (!editor.viewOnly && (e.key === 'Delete' || e.key === 'Backspace')) deleteSelected();
    if (e.key === 'Escape') {
      editor.selected = -1;
      editor.selFinish = false;
      renderPropsPanel();
    }
    if (e.key === 'ArrowDown') editor.camY = clampCam(editor.camY + 80, editor.height);
    if (e.key === 'ArrowUp') editor.camY = clampCam(editor.camY - 80, editor.height);
  });

  $('btn-map-save').addEventListener('click', () => {
    const name = $('input-map-name').value.trim();
    const msg = $('editor-msg');
    if (!name) return (msg.textContent = '맵 이름을 입력해주세요.');
    if (editor.comps.length === 0)
      return (msg.textContent = '구성요소를 1개 이상 배치해주세요.');

    const components = editor.comps.map(({ type, x, y, props }) => ({ type, x, y, props }));
    const finish = editor.finish ? { ...editor.finish } : undefined;

    // 관리자 재편집: 기존 맵을 덮어쓰기 (HTTP admin API)
    if (editor.adminEditId) {
      fetch('/api/admin/maps/update', {
        method: 'POST',
        headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editor.adminEditId, name, components, height: editor.height, width: editor.width, finish }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (!res.ok) return (msg.textContent = res.error || '저장 실패');
          mapThumbCache.delete(editor.adminEditId); // 썸네일 캐시 갱신
          editor.adminEditId = null;
          showScreen('admin'); // 관리자 전용 페이지로 복귀 (키 유지)
          loadAdmin();
        })
        .catch(() => (msg.textContent = '저장 실패'));
      return;
    }

    socket.emit('maps:save', { name, components, height: editor.height, width: editor.width, finish }, (res) => {
      if (!res.ok) return (msg.textContent = res.error || '저장 실패');
      // 방장이면 방금 만든 맵을 바로 선택
      if (room && room.hostId === myId) socket.emit('room:setMap', { mapId: res.id });
      if (editor.from === 'maps') {
        renderMapsGallery();
        showScreen('maps');
      } else if (room) {
        renderLobby();
        showScreen('lobby');
      } else {
        showScreen('home');
      }
    });
  });

  function renderEditor() {
    if (!editor.active) return;
    const camY = editor.camY;
    eCtx.setTransform(eScale, 0, 0, eScale, 0, 0);
    eCtx.clearRect(0, 0, VIEW.width, VIEW.height);
    eCtx.save();
    eCtx.translate(0, -camY);

    // 배치 불가 구역 표시
    const maxY = editMaxY();
    const eW = editor.width;
    eCtx.fillStyle = 'rgba(212,175,55,0.05)';
    eCtx.fillRect(0, 0, eW, EDIT_BOUNDS.minY - 20);
    eCtx.fillStyle = 'rgba(212,175,55,0.07)';
    eCtx.fillRect(0, maxY + 20, eW, editor.height - maxY - 20);
    eCtx.font = '13px sans-serif';
    eCtx.textAlign = 'center';
    eCtx.fillStyle = 'rgba(212,175,55,0.55)';
    eCtx.fillText('⬇ 공 시작 구역', eW / 2, 60);

    // 맵 바닥 경계선
    eCtx.strokeStyle = 'rgba(212,175,55,0.4)';
    eCtx.lineWidth = 2;
    eCtx.beginPath();
    eCtx.moveTo(0, editor.height);
    eCtx.lineTo(eW, editor.height);
    eCtx.stroke();

    // 🏁 골인 존 (드래그로 이동·크기조절) — 실제 게임과 동일한 모양으로 미리보기
    if (editor.finish) {
      const f = editor.finish;
      drawGoal(eCtx, f);
      // 존 영역 반투명 박스 (높이 표시)
      eCtx.fillStyle = editor.selFinish ? 'rgba(53,224,255,0.14)' : 'rgba(53,224,255,0.06)';
      eCtx.fillRect(f.x - f.width / 2, f.y, f.width, f.height);
      if (editor.selFinish) {
        eCtx.strokeStyle = '#35e0ff';
        eCtx.lineWidth = 2;
        eCtx.setLineDash([7, 5]);
        eCtx.strokeRect(f.x - f.width / 2, f.y, f.width, f.height);
        eCtx.setLineDash([]);
        // 모서리 핸들
        eCtx.fillStyle = '#35e0ff';
        for (const hx of [f.x - f.width / 2, f.x + f.width / 2]) {
          for (const hy of [f.y, f.y + f.height]) {
            eCtx.fillRect(hx - 3, hy - 3, 6, 6);
          }
        }
      }
    }

    // 구성요소 (회전체는 미리보기로 실제 속도로 회전)
    const t = performance.now() / 1000;
    editor.comps.forEach((comp, i) => {
      if (comp.y < camY - 300 || comp.y > camY + VIEW.height + 300) return;
      drawComponent(eCtx, comp, comp.spin ? comp.spin * t : 0);
      if (i === editor.selected) {
        eCtx.strokeStyle = '#d4af37';
        eCtx.lineWidth = 2;
        eCtx.setLineDash([6, 4]);
        let radius = 16;
        for (const s of comp.shapes) {
          const off = Math.hypot(s.x, s.y);
          radius = Math.max(radius, off + (s.kind === 'circle' ? s.r : Math.max(s.w, s.h) / 2));
        }
        eCtx.beginPath();
        eCtx.arc(comp.x, comp.y, radius + 6, 0, Math.PI * 2);
        eCtx.stroke();
        // 폭탄 등: 발동 범위 미리보기
        if (comp.hit && comp.hit.radius) {
          eCtx.strokeStyle = 'rgba(255,176,58,0.55)';
          eCtx.beginPath();
          eCtx.arc(comp.x, comp.y, comp.hit.radius, 0, Math.PI * 2);
          eCtx.stroke();
        }
        // ↔️ 움직이는 벽: 왕복 이동 범위(트랙) 표시
        if (comp.move) {
          const rng = comp.move.range;
          eCtx.strokeStyle = 'rgba(180,140,232,0.7)';
          eCtx.beginPath();
          if (comp.move.axis === 'y') {
            eCtx.moveTo(comp.x, comp.y - rng);
            eCtx.lineTo(comp.x, comp.y + rng);
          } else {
            eCtx.moveTo(comp.x - rng, comp.y);
            eCtx.lineTo(comp.x + rng, comp.y);
          }
          eCtx.stroke();
        }
        eCtx.setLineDash([]);
      }
    });

    eCtx.restore();

    // 에디터 미니맵
    drawMinimap(eMinimap, {
      width: editor.width,
      height: editor.height,
      components: editor.comps,
      camY,
      elapsed: t,
      selected: editor.selected >= 0 ? editor.comps[editor.selected] : null,
      dynamic: true, // 편집 중이므로 캐시 없이
    });

    requestAnimationFrame(renderEditor);
  }

  // 창 크기 변경 시 미니맵 표시 크기 다시 계산
  window.addEventListener('resize', () => {
    if (game) setupCanvas();
    if (editor.active) setupEditorCanvas();
  });

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // 모든 선언·초기화가 끝난 뒤에 관리자 페이지 자동 오픈 (editor const 초기화 이후여야 함)
  if (ADMIN_MODE) openAdmin();
})();
