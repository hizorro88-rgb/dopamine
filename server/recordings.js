/**
 * 결과 녹화 저장소 (data/recordings/*.json.gz 영구 저장)
 * ──────────────────────────────────────────────────────
 * 이벤트 추첨 결과(리플레이)를 디스크에 영구 저장하고, 짧은 공유 코드를 발급한다.
 * 공유 링크(?replay=CODE)를 받은 사람은 이벤트에 참가하지 않아도
 * /api/recording/:code 로 리플레이를 내려받아 그대로 관람할 수 있다.
 *
 * 리플레이는 이미 gzip 으로 압축된 버퍼를 그대로 저장하므로(추가 압축 없음)
 * 서빙할 때도 Content-Encoding: gzip 으로 그대로 흘려보내면 된다.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJSON } = require('./security');

const DATA_DIR = path.join(__dirname, '..', 'data', 'recordings');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

// 저장 상한 — 넘으면 가장 오래된 것부터 지운다(디스크 무한 증가 방지).
const MAX_RECORDINGS = Math.max(50, Number(process.env.MAX_RECORDINGS) || 1000);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return code;
}

class RecordingStore {
  constructor() {
    this.index = []; // [{ code, createdAt, mapName, count }]
    this.load();
  }

  load() {
    try {
      this.index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      if (!Array.isArray(this.index)) this.index = [];
    } catch {
      this.index = [];
    }
  }

  persist() {
    atomicWriteJSON(INDEX_FILE, this.index);
  }

  fileOf(code) {
    return path.join(DATA_DIR, code + '.json.gz');
  }

  /**
   * gzip 으로 압축된 리플레이 버퍼를 저장하고 공유 코드를 발급한다.
   * @param {Buffer} gzBuffer  gzip(JSON) 버퍼
   * @param {{mapName?:string, count?:number}} meta
   */
  save(gzBuffer, meta = {}) {
    if (!Buffer.isBuffer(gzBuffer) || gzBuffer.length === 0) {
      return { ok: false, error: '저장할 결과가 없습니다.' };
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let code;
    do {
      code = randomCode();
    } while (this.index.some((r) => r.code === code) || fs.existsSync(this.fileOf(code)));

    try {
      fs.writeFileSync(this.fileOf(code), gzBuffer);
    } catch (err) {
      console.error('녹화 저장 실패:', err);
      return { ok: false, error: '결과 저장에 실패했습니다.' };
    }
    this.index.push({
      code,
      createdAt: Date.now(),
      mapName: String(meta.mapName || '').slice(0, 40),
      count: Math.max(0, Number(meta.count) || 0),
    });
    this.evict();
    this.persist();
    return { ok: true, code };
  }

  /** 상한 초과 시 오래된 녹화부터 파일·색인에서 제거 */
  evict() {
    while (this.index.length > MAX_RECORDINGS) {
      const old = this.index.shift();
      try {
        fs.unlinkSync(this.fileOf(old.code));
      } catch {
        /* 이미 없으면 무시 */
      }
    }
  }

  /** 저장된 gzip 리플레이 버퍼 반환 (없으면 null) */
  getGz(code) {
    const clean = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(clean)) return null; // 경로 조작 방지
    if (!this.index.some((r) => r.code === clean)) return null;
    try {
      return fs.readFileSync(this.fileOf(clean));
    } catch {
      return null;
    }
  }
}

module.exports = { RecordingStore };
