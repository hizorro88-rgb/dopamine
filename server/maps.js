/**
 * 맵 저장소: 기본 제공 맵 + 유저 제작 맵 (data/maps.json 에 영구 저장)
 * 유저가 에디터에서 저장한 맵은 서버의 모든 방에서 선택할 수 있다.
 */

const fs = require('fs');
const path = require('path');
const { COMPONENTS, defaultProps } = require('../public/components.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'maps.json');

// 에디터에서 배치 가능한 영역 (위: 공 시작 구역 / 아래: 골인 구역 제외)
const BOUNDS = { minX: 25, maxX: 575, minY: 130, maxY: 800 };
const MAX_COMPONENTS = 150;
const MAX_CUSTOM_MAPS = 200;

// ── 기본 맵 ──────────────────────────────────────────────

function peg(x, y, size = 8) {
  return { type: 'peg', x, y, props: { size } };
}

function funnel() {
  return [
    { type: 'wall', x: 115, y: 745, props: { length: 290, angle: 27.5 } },
    { type: 'wall', x: 485, y: 745, props: { length: 290, angle: -27.5 } },
    { type: 'wall', x: 232, y: 835, props: { length: 70, angle: 90 } },
    { type: 'wall', x: 368, y: 835, props: { length: 70, angle: 90 } },
  ];
}

function classicComponents() {
  const comps = [];
  let row = 0;
  for (let y = 170; y <= 640; y += 58) {
    const offset = row % 2 === 0 ? 0 : 29;
    for (let x = 55 + offset; x <= 545; x += 58) comps.push(peg(x, y));
    row++;
  }
  return [...comps, ...funnel()];
}

function spinnerParkComponents() {
  const comps = [];
  for (let x = 84; x <= 516; x += 54) comps.push(peg(x, 170));
  for (let x = 111; x <= 489; x += 54) comps.push(peg(x, 222));

  comps.push({ type: 'bumper', x: 300, y: 305, props: { size: 24 } });
  comps.push({ type: 'bumper', x: 85, y: 370, props: { size: 18 } });
  comps.push({ type: 'bumper', x: 515, y: 370, props: { size: 18 } });

  comps.push({ type: 'spinner', x: 170, y: 440, props: { length: 160, speed: 2 } });
  comps.push({ type: 'spinner', x: 430, y: 440, props: { length: 160, speed: -2 } });
  comps.push({ type: 'cross', x: 300, y: 575, props: { length: 150, speed: 1.5 } });

  for (let x = 84; x <= 516; x += 54) comps.push(peg(x, 668));
  return [...comps, ...funnel()];
}

const BUILTIN_MAPS = [
  {
    id: 'classic',
    name: '클래식',
    author: '기본 맵',
    builtin: true,
    components: classicComponents(),
  },
  {
    id: 'spinner-park',
    name: '스피너 파크',
    author: '기본 맵',
    builtin: true,
    components: spinnerParkComponents(),
  },
];

// ── 저장소 ──────────────────────────────────────────────

class MapStore {
  constructor() {
    this.builtins = new Map(BUILTIN_MAPS.map((m) => [m.id, m]));
    this.custom = new Map();
    this.load();
  }

  load() {
    try {
      const arr = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const m of arr) this.custom.set(m.id, m);
    } catch {
      /* 파일 없으면 무시 */
    }
  }

  persist() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([...this.custom.values()], null, 2));
  }

  /** 맵 목록 (메타데이터만) */
  list() {
    const meta = (m) => ({
      id: m.id,
      name: m.name,
      author: m.author,
      builtin: !!m.builtin,
      count: m.components.length,
    });
    return [...this.builtins.values(), ...this.custom.values()].map(meta);
  }

  get(id) {
    return this.builtins.get(id) || this.custom.get(id) || null;
  }

  /**
   * 유저 맵 저장 (검증 포함)
   * @returns {{ok: true, id: string} | {ok: false, error: string}}
   */
  save({ name, author, components } = {}) {
    const cleanName = String(name || '').trim().slice(0, 20);
    if (!cleanName) return { ok: false, error: '맵 이름을 입력해주세요.' };
    if (!Array.isArray(components) || components.length === 0)
      return { ok: false, error: '구성요소를 1개 이상 배치해주세요.' };
    if (components.length > MAX_COMPONENTS)
      return { ok: false, error: `구성요소는 최대 ${MAX_COMPONENTS}개까지 가능합니다.` };
    if (this.custom.size >= MAX_CUSTOM_MAPS)
      return { ok: false, error: '서버에 저장된 맵이 너무 많습니다.' };

    const validated = [];
    for (const comp of components) {
      const def = COMPONENTS[comp && comp.type];
      if (!def) return { ok: false, error: `알 수 없는 구성요소: ${comp && comp.type}` };

      const x = clamp(Number(comp.x), BOUNDS.minX, BOUNDS.maxX);
      const y = clamp(Number(comp.y), BOUNDS.minY, BOUNDS.maxY);
      if (!Number.isFinite(x) || !Number.isFinite(y))
        return { ok: false, error: '잘못된 좌표가 있습니다.' };

      // props 는 스키마에 정의된 키만, min/max 로 잘라서 저장
      const props = defaultProps(def);
      for (const schema of def.props) {
        const v = Number(comp.props && comp.props[schema.key]);
        if (Number.isFinite(v)) props[schema.key] = clamp(v, schema.min, schema.max);
      }
      validated.push({ type: def.id, x: Math.round(x), y: Math.round(y), props });
    }

    const id = 'm' + Math.random().toString(36).slice(2, 10);
    this.custom.set(id, {
      id,
      name: cleanName,
      author: String(author || '익명').trim().slice(0, 12) || '익명',
      components: validated,
      createdAt: Date.now(),
    });
    this.persist();
    return { ok: true, id };
  }
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

module.exports = { MapStore, BOUNDS };
