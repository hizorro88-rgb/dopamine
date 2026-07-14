/**
 * 보안 공용 유틸: 원자적 파일 쓰기 + 간단한 인메모리 레이트 리미터.
 * 외부 의존성 없이(=배포 환경에서 npm 설치 불필요) 동작하도록 순수 Node API만 사용한다.
 */

const fs = require('fs');
const path = require('path');

/**
 * 원자적 JSON 저장: 임시 파일에 먼저 쓰고 rename 으로 교체한다.
 * 쓰기 도중 크래시·디스크풀이 나도 기존 파일이 반쯤 덮여 손상되지 않는다(rename 은 원자적).
 */
function atomicWriteJSON(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/**
 * 슬라이딩 윈도 레이트 리미터. key(보통 IP 또는 socket.id) 기준으로
 * windowMs 동안 max 회까지만 허용한다. 오래된 기록은 주기적으로 청소한다.
 */
class RateLimiter {
  constructor(windowMs, max) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map(); // key -> { start, count }
    // 메모리 누수 방지: 윈도가 지난 기록을 주기적으로 제거 (프로세스 종료를 막지 않도록 unref)
    this.timer = setInterval(() => this.sweep(), Math.max(windowMs, 30000));
    if (this.timer.unref) this.timer.unref();
  }

  /** 허용되면 true, 한도 초과면 false */
  allow(key) {
    const now = Date.now();
    let rec = this.hits.get(key);
    if (!rec || now - rec.start >= this.windowMs) {
      rec = { start: now, count: 0 };
      this.hits.set(key, rec);
    }
    rec.count++;
    return rec.count <= this.max;
  }

  sweep() {
    const now = Date.now();
    for (const [key, rec] of this.hits) {
      if (now - rec.start >= this.windowMs) this.hits.delete(key);
    }
  }
}

module.exports = { atomicWriteJSON, RateLimiter };
