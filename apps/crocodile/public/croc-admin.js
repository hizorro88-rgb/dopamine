/**
 * 🐊 잇몸 곡선 편집기 (/dopaman/crocodile)
 *
 * 사진 위에 잇몸선을 직접 점으로 찍어 그리면, 그 곡선의 양 끝에 첫·마지막 이빨을 두고
 * 사이를 곡선 길이 기준으로 균등 분할해 배치한다. 계산은 croc-curve.js 를 그대로 쓰므로
 * 여기 미리보기가 실제 게임 화면과 정확히 같다.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const PW = 720, PH = 1280;
  const CHARS = [
    { id: 'crocodile', label: '🐊 악어' },
    { id: 'shark', label: '🦈 상어' },
    { id: 'dino', label: '🦖 공룡' },
  ];

  let adminKey = '';
  let stages = null;   // 서버에서 받은 전체 설정
  let cur = 'crocodile';
  let dragIdx = -1;

  const cfg = () => stages[cur];
  const svgEl = (t, at) => {
    const n = document.createElementNS(NS, t);
    for (const k in at) n.setAttribute(k, at[k]);
    return n;
  };

  // ── 로그인 / 불러오기 ─────────────────────────────────────
  function say(text, bad) {
    $('msg').textContent = text || '';
    $('msg').classList.toggle('bad', !!bad);
  }
  async function load() {
    adminKey = $('admin-key').value.trim();
    if (!adminKey) return say('관리자 키를 입력해주세요.', true);
    say('불러오는 중…');
    try {
      const r = await fetch('/api/admin/croc/stage', { headers: { 'x-admin-key': adminKey } });
      const j = await r.json();
      if (!r.ok || !j.ok) return say(j.error || '불러오지 못했습니다.', true);
      stages = j.stages;
      say('');
      $('app').classList.remove('hidden');
      buildTabs();
      selectChar(cur);
    } catch (e) {
      say('서버에 연결하지 못했습니다: ' + e.message, true);
    }
  }
  $('btn-load').addEventListener('click', load);
  $('admin-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });

  // ── 캐릭터 탭 ────────────────────────────────────────────
  function buildTabs() {
    const t = $('tabs'); t.innerHTML = '';
    for (const c of CHARS) {
      const b = document.createElement('button');
      b.textContent = c.label;
      b.onclick = () => selectChar(c.id);
      b.dataset.id = c.id;
      t.appendChild(b);
    }
  }
  function selectChar(id) {
    cur = id;
    [...$('tabs').children].forEach((b) => b.classList.toggle('on', b.dataset.id === id));
    $('bg').src = '/crocodile/stage/' + id + '.jpg';
    syncControls();
    render();
  }

  // ── 조절판 ↔ 설정 ────────────────────────────────────────
  const SLIDERS = ['toothH', 'toothW', 'tilt', 'maxTilt', 'zoom'];
  function syncControls() {
    const c = cfg();
    for (const k of SLIDERS) { $(k).value = c[k]; $(k + '-val').textContent = c[k]; }
    $('emptyGums').checked = !!c.emptyGums;
    $('coords').value = JSON.stringify(c.arch.map((p) => [round(p[0]), round(p[1])]));
  }
  for (const k of SLIDERS) {
    $(k).addEventListener('input', () => {
      cfg()[k] = Number($(k).value);
      $(k + '-val').textContent = $(k).value;
      render();
    });
  }
  $('emptyGums').addEventListener('change', () => { cfg().emptyGums = $('emptyGums').checked; render(); });
  $('n').addEventListener('input', () => { $('n-val').textContent = $('n').value; render(); });
  $('show-teeth').addEventListener('change', render);
  $('show-zoom').addEventListener('change', render);
  $('btn-apply-coords').addEventListener('click', () => {
    try {
      const pts = JSON.parse($('coords').value);
      if (!Array.isArray(pts) || pts.length < 2) throw new Error('점이 2개 이상이어야 합니다.');
      cfg().arch = pts.map((p) => [Number(p[0]), Number(p[1])]);
      render();
      saveMsg('좌표를 적용했어요. 저장 버튼을 눌러야 반영됩니다.');
    } catch (e) { saveMsg('좌표 형식 오류: ' + e.message, true); }
  });

  // ── 그리기 ───────────────────────────────────────────────
  function render() {
    const c = cfg();
    const n = Number($('n').value);
    $('curve').setAttribute('d', window.CrocCurve.pathD(c.arch));

    // 이빨 미리보기
    const g = $('teeth'); g.innerHTML = '';
    if ($('show-teeth').checked) {
      for (const t of window.CrocCurve.layout(c, n)) {
        const tg = svgEl('g', { transform: `translate(${t.x.toFixed(1)},${t.y.toFixed(1)}) rotate(${t.ang.toFixed(1)})` });
        tg.appendChild(svgEl('path', {
          d: `M${-t.w / 2},0 Q${-t.w * 0.36},${-t.h * 0.55} 0,${-t.h} Q${t.w * 0.36},${-t.h * 0.55} ${t.w / 2},0 Z`,
          fill: 'url(#pTooth)', stroke: 'rgba(86,66,44,.6)', 'stroke-width': 1.4,
        }));
        g.appendChild(tg);
      }
    }

    // 조절점
    const h = $('handles'); h.innerHTML = '';
    c.arch.forEach((p, i) => {
      const last = i === c.arch.length - 1;
      const dot = svgEl('circle', {
        class: 'handle' + (i === 0 || last ? ' end' : ''),
        cx: p[0], cy: p[1], r: 11, 'data-i': i,
      });
      h.appendChild(dot);
      // 좌표는 지금 끌고 있는 점에만 — 안 그러면 화면이 숫자로 덮인다
      if (i === dragIdx) {
        const label = svgEl('text', { class: 'hlabel', x: p[0] + 15, y: p[1] - 12 });
        label.textContent = `${round(p[0])},${round(p[1])}`;
        h.appendChild(label);
      }
    });

    $('canvas').classList.toggle('zoomed', $('show-zoom').checked);
    $('canvas').style.setProperty('--z', c.zoom);
    $('coords').value = JSON.stringify(c.arch.map((p) => [round(p[0]), round(p[1])]));
  }
  const round = (v) => Math.round(v * 10) / 10;

  // 화면 좌표 → 사진(720×1280) 좌표
  function toPhoto(ev) {
    const svg = $('svg'), r = svg.getBoundingClientRect();
    // viewBox 는 meet(=contain) 이라 실제 그려지는 영역이 레터박스될 수 있다
    const s = Math.min(r.width / PW, r.height / PH);
    const ox = (r.width - PW * s) / 2, oy = (r.height - PH * s) / 2;
    return { x: (ev.clientX - r.left - ox) / s, y: (ev.clientY - r.top - oy) / s };
  }

  $('svg').addEventListener('pointerdown', (ev) => {
    const i = ev.target.dataset && ev.target.dataset.i;
    if (i !== undefined) {                       // 점 잡기
      dragIdx = Number(i);
      $('svg').setPointerCapture(ev.pointerId);
      ev.preventDefault();
      return;
    }
    // 빈 곳 클릭 → 가장 가까운 구간에 점 삽입 (곡선 모양을 유지한 채 늘어난다)
    const p = toPhoto(ev);
    const arch = cfg().arch;
    let best = 1, bestD = Infinity;
    for (let k = 1; k < arch.length; k++) {
      const d = segDist(p, arch[k - 1], arch[k]);
      if (d < bestD) { bestD = d; best = k; }
    }
    // 양 끝 바깥을 찍으면 끝점을 연장한다
    const dHead = Math.hypot(p.x - arch[0][0], p.y - arch[0][1]);
    const dTail = Math.hypot(p.x - arch[arch.length - 1][0], p.y - arch[arch.length - 1][1]);
    if (p.x < arch[0][0] && dHead < bestD * 2.5) arch.unshift([p.x, p.y]);
    else if (p.x > arch[arch.length - 1][0] && dTail < bestD * 2.5) arch.push([p.x, p.y]);
    else arch.splice(best, 0, [p.x, p.y]);
    render();
  });
  $('svg').addEventListener('pointermove', (ev) => {
    if (dragIdx < 0) return;
    const p = toPhoto(ev);
    cfg().arch[dragIdx] = [clamp(p.x, -100, PW + 100), clamp(p.y, -100, PH + 100)];
    render();
  });
  const endDrag = () => { dragIdx = -1; };
  $('svg').addEventListener('pointerup', endDrag);
  $('svg').addEventListener('pointercancel', endDrag);
  $('svg').addEventListener('dblclick', (ev) => {
    const i = ev.target.dataset && ev.target.dataset.i;
    if (i === undefined) return;
    if (cfg().arch.length <= 2) return saveMsg('점은 2개 이상 있어야 합니다.', true);
    cfg().arch.splice(Number(i), 1);
    render();
  });
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // 점 p 와 선분 ab 의 거리
  function segDist(p, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const L2 = vx * vx + vy * vy || 1;
    let t = ((p.x - a[0]) * vx + (p.y - a[1]) * vy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a[0] + vx * t), p.y - (a[1] + vy * t));
  }

  // ── 저장 ─────────────────────────────────────────────────
  function saveMsg(text, bad) {
    const el = $('save-msg');
    el.textContent = text; el.classList.toggle('bad', !!bad);
    clearTimeout(saveMsg._t);
    saveMsg._t = setTimeout(() => { el.textContent = ''; }, 4000);
  }
  async function post(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  }
  $('btn-save').addEventListener('click', async () => {
    const c = cfg();
    const j = await post('/api/admin/croc/stage', {
      character: cur,
      arch: c.arch, toothH: c.toothH, toothW: c.toothW,
      tilt: c.tilt, maxTilt: c.maxTilt, zoom: c.zoom, emptyGums: c.emptyGums,
    });
    if (!j.ok) return saveMsg(j.error || '저장 실패', true);
    stages[cur] = j.stage;
    syncControls(); render();
    saveMsg('저장했습니다 ✓ 게임을 새로고침하면 바로 반영돼요.');
  });
  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('이 캐릭터 설정을 기본값으로 되돌릴까요?')) return;
    const j = await post('/api/admin/croc/stage/reset', { character: cur });
    if (!j.ok) return saveMsg(j.error || '실패', true);
    stages[cur] = j.stage;
    syncControls(); render();
    saveMsg('기본값으로 되돌렸습니다.');
  });

  $('n-val').textContent = $('n').value;
  $('admin-key').focus();
})();
