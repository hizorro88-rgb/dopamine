/**
 * .env 파일(저장소 루트)을 읽어 process.env 를 채운다.
 * - 외부 의존성(dotenv) 없이 순수 Node 로 동작
 * - 이미 지정된(비어있지 않은) 환경변수는 덮어쓰지 않는다 (start.bat 의 set 이 우선)
 * 자동 배포(git pull) 시 설정이 코드와 충돌하지 않도록, 비밀키·설정은 .env(추적 안 됨)에 둔다.
 */
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const file = path.join(__dirname, '..', '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // .env 없으면 무시 (start.bat 의 set 만으로도 동작)
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // 아직 지정 안 됐거나 빈 문자열이면 .env 값으로 채운다
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = val;
    }
  }
}

module.exports = { loadEnv };
