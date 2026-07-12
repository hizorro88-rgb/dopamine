/**
 * 후원자 저장소 (data/donors.json 영구 저장)
 *
 * 관리자가 후원자를 등록하면 후원자 코드(DN-XXXXXX)가 발급된다.
 * 코드를 후원자에게 전달하면, 후원자는 홈 화면에서 코드를 입력해
 * 💖 배지 + 에픽 아이템 확률 UP 혜택을 받는다.
 *
 * 등록 방법 (ADMIN_KEY 환경변수 필요):
 *   curl -X POST http://서버주소/api/admin/donors \
 *     -H "x-admin-key: 관리자키" -H "Content-Type: application/json" \
 *     -d '{"name":"홍길동","amount":10000}'
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'donors.json');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class DonorStore {
  constructor() {
    this.donors = [];
    this.load();
  }

  load() {
    try {
      this.donors = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
      this.donors = [];
    }
  }

  persist() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(this.donors, null, 2));
  }

  /** 후원자 등록 → 후원자 코드 발급 */
  add({ name, amount } = {}) {
    const cleanName = String(name || '').trim().slice(0, 12);
    if (!cleanName) return { ok: false, error: '후원자 이름을 입력해주세요.' };

    let code;
    do {
      code = 'DN-';
      for (let i = 0; i < 6; i++) {
        code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      }
    } while (this.donors.some((d) => d.code === code));

    this.donors.push({
      name: cleanName,
      amount: Math.max(0, Number(amount) || 0),
      code,
      since: Date.now(),
    });
    this.persist();
    return { ok: true, code, name: cleanName };
  }

  findByCode(code) {
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) return null;
    return this.donors.find((d) => d.code === clean) || null;
  }

  /** 명예의 전당용 공개 목록 (코드 제외, 후원 금액 큰 순) */
  list() {
    return [...this.donors]
      .sort((a, b) => b.amount - a.amount || a.since - b.since)
      .map((d) => ({ name: d.name, amount: d.amount, since: d.since }));
  }
}

module.exports = { DonorStore };
