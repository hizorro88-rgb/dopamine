/**
 * 🖼 실사 무대(사진) 설정 저장소 — data/croc-stage.json
 *
 * 관리자 페이지(/dopaman/crocodile)에서 캐릭터별로 잇몸 곡선을 직접 그려 저장한다.
 * 게임 클라이언트는 /api/croc/stage 로 읽어가서 그 곡선 위에 이빨을 배치한다.
 * 파일이 없거나 값이 없으면 아래 DEFAULTS 로 동작한다 (기존 하드코딩 값과 동일).
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('../../server/security');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'croc-stage.json');
const STAGE_DIR = path.join(__dirname, 'public', 'stage');

/**
 * 무대 리비전.
 * 코드 쪽에서 사진을 바꾸거나 이빨 모양·기본 좌표를 갈아엎으면 이 숫자를 올린다.
 * 저장된 설정의 rev 가 다르면 그 캐릭터는 새 기본값으로 되돌린다 —
 * 안 그러면 예전에 관리자 페이지에서 한 번 저장해둔 값이 새 기본값을 계속 덮어써서
 * "코드는 바꿨는데 화면은 그대로"인 상황이 된다.
 */
const REV = 2;

// arch: 잇몸 곡선을 지나는 점들 [[x,y], …] — 사진 720×1280 좌표계, 왼쪽→오른쪽 순서
const DEFAULTS = {
  crocodile: {
    arch: [[218, 830], [296, 943], [374, 978], [451, 937], [528, 818]],
    toothH: 60, toothW: 0.42, aspect: 0.5, tilt: 0, jitter: 12, maxTilt: 30, zoom: 1.62,
    style: 'conic', emptyGums: true, rev: REV,
  },
  shark: {
    arch: [[220, 765], [280, 805], [360, 833], [445, 822], [538, 755]],
    toothH: 56, toothW: 0.72, aspect: 0.58, tilt: 0, jitter: 12, maxTilt: 30, zoom: 1.5,
    style: 'triangle', emptyGums: true, rev: REV,
  },
  dino: {
    arch: [[238, 843], [287, 927], [363, 945], [443, 933], [505, 850]],
    toothH: 78, toothW: 0.62, aspect: 0.26, tilt: 0, jitter: 10, maxTilt: 30, zoom: 1.5,
    style: 'banana', emptyGums: true, rev: REV,
  },
};

const CHARACTERS = Object.keys(DEFAULTS);
const PW = 720, PH = 1280;

const clone = (o) => JSON.parse(JSON.stringify(o));

class StageStore {
  constructor() {
    this.data = clone(DEFAULTS);
    this.resetByUpdate = []; // 리비전이 올라 기본값으로 되돌린 캐릭터
    try {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const c of CHARACTERS) {
        const sv = saved && saved[c];
        if (!sv) continue;
        if (Number(sv.rev || 1) !== DEFAULTS[c].rev) { this.resetByUpdate.push(c); continue; }
        this.data[c] = { ...this.data[c], ...sv };
      }
    } catch {
      /* 파일 없으면 기본값 */
    }
    if (this.resetByUpdate.length) {
      console.log(
        `[croc] 무대가 업데이트되어 ${this.resetByUpdate.join(', ')} 설정을 새 기본값으로 되돌렸습니다.`
        + ' (관리자 페이지에서 다시 다듬을 수 있어요)'
      );
    }
  }

  /** 사진 파일의 수정시각 → 캐시 무효화용 버전 문자열 */
  stageVersion(character) {
    try {
      return Math.floor(fs.statSync(path.join(STAGE_DIR, character + '.jpg')).mtimeMs).toString(36);
    } catch {
      return '0';
    }
  }
  /** 게임/편집기에 내려줄 형태 — 사진 URL 에 버전을 붙여 옛 사진이 캐시되는 걸 막는다 */
  publicAll() {
    const out = clone(this.data);
    for (const c of CHARACTERS) out[c].v = this.stageVersion(c);
    return out;
  }

  all() {
    return clone(this.data);
  }
  defaults() {
    return clone(DEFAULTS);
  }

  /** 한 캐릭터의 설정을 검증해 저장 → {ok, stage} | {ok:false, error} */
  update(character, patch = {}) {
    if (!CHARACTERS.includes(character)) return { ok: false, error: '알 수 없는 캐릭터입니다.' };
    const cur = { ...this.data[character] };
    try {
      if (patch.arch !== undefined) cur.arch = validArch(patch.arch);
      if (patch.toothH !== undefined) cur.toothH = num(patch.toothH, 8, 400, '이빨 길이');
      if (patch.toothW !== undefined) cur.toothW = num(patch.toothW, 0.1, 2, '이빨 두께', true);
      if (patch.aspect !== undefined) cur.aspect = num(patch.aspect, 0.1, 1.5, '가로세로 비율', true);
      if (patch.tilt !== undefined) cur.tilt = num(patch.tilt, 0, 1.5, '잇몸선 따라가기', true);
      if (patch.jitter !== undefined) cur.jitter = num(patch.jitter, 0, 45, '삐뚤빼뚤', true);
      if (patch.maxTilt !== undefined) cur.maxTilt = num(patch.maxTilt, 0, 90, '최대 기울기');
      if (patch.zoom !== undefined) cur.zoom = num(patch.zoom, 1, 3, '확대', true);
      if (patch.style !== undefined) cur.style = ['conic', 'triangle', 'banana'].includes(patch.style) ? patch.style : cur.style;
      if (patch.emptyGums !== undefined) cur.emptyGums = !!patch.emptyGums;
    } catch (e) {
      return { ok: false, error: e.message };
    }
    cur.rev = DEFAULTS[character].rev; // 지금 코드 기준으로 저장됐다고 표시
    this.data[character] = cur;
    atomicWriteJSON(DATA_FILE, this.data);
    return { ok: true, stage: clone(cur) };
  }

  /** 기본값으로 되돌리기 */
  reset(character) {
    if (!CHARACTERS.includes(character)) return { ok: false, error: '알 수 없는 캐릭터입니다.' };
    this.data[character] = clone(DEFAULTS[character]);
    atomicWriteJSON(DATA_FILE, this.data);
    return { ok: true, stage: clone(this.data[character]) };
  }
}

function num(v, min, max, label, float) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label}은(는) ${min}~${max} 이어야 합니다.`);
  return float ? Math.round(n * 1000) / 1000 : Math.round(n);
}

function validArch(arch) {
  if (!Array.isArray(arch) || arch.length < 2 || arch.length > 24)
    throw new Error('잇몸 곡선은 점 2~24개여야 합니다.');
  return arch.map((p) => {
    if (!Array.isArray(p) || p.length < 2) throw new Error('잇몸 곡선 좌표 형식이 올바르지 않습니다.');
    const x = Number(p[0]), y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('잇몸 곡선 좌표가 숫자가 아닙니다.');
    return [clamp(x, -200, PW + 200), clamp(y, -200, PH + 200)];
  });
}
const clamp = (v, a, b) => Math.round(Math.min(b, Math.max(a, v)) * 10) / 10;

module.exports = { StageStore, CHARACTERS, DEFAULTS: clone(DEFAULTS), PW, PH };
