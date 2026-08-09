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

// arch: 잇몸 곡선을 지나는 점들 [[x,y], …] — 사진 720×1280 좌표계, 왼쪽→오른쪽 순서
const DEFAULTS = {
  crocodile: {
    arch: [[218, 830], [296, 943], [374, 978], [451, 937], [528, 818]],
    toothH: 60, toothW: 0.42, tilt: 0.48, maxTilt: 32, zoom: 1.62, emptyGums: true,
  },
  shark: {
    arch: [[228, 820], [300, 832], [374, 834], [449, 828], [526, 812]],
    toothH: 78, toothW: 0.62, tilt: 0.48, maxTilt: 32, zoom: 1, emptyGums: false,
  },
  dino: {
    arch: [[256, 908], [314, 940], [373, 952], [431, 944], [490, 916]],
    toothH: 104, toothW: 0.78, tilt: 0.48, maxTilt: 32, zoom: 1, emptyGums: false,
  },
};

const CHARACTERS = Object.keys(DEFAULTS);
const PW = 720, PH = 1280;

const clone = (o) => JSON.parse(JSON.stringify(o));

class StageStore {
  constructor() {
    this.data = clone(DEFAULTS);
    try {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const c of CHARACTERS) {
        if (saved && saved[c]) this.data[c] = { ...this.data[c], ...saved[c] };
      }
    } catch {
      /* 파일 없으면 기본값 */
    }
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
      if (patch.tilt !== undefined) cur.tilt = num(patch.tilt, 0, 1.5, '기울기', true);
      if (patch.maxTilt !== undefined) cur.maxTilt = num(patch.maxTilt, 0, 90, '최대 기울기');
      if (patch.zoom !== undefined) cur.zoom = num(patch.zoom, 1, 3, '확대', true);
      if (patch.emptyGums !== undefined) cur.emptyGums = !!patch.emptyGums;
    } catch (e) {
      return { ok: false, error: e.message };
    }
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
