/**
 * 자동 배포 감시자 (self-hosted)
 * ─────────────────────────────
 * - server/index.js 를 자식 프로세스로 띄워 감독한다 (죽으면 자동 재시작)
 * - 주기적으로 origin 의 현재 브랜치를 확인해서 새 커밋이 있으면
 *   git pull → (package.json 바뀌면 npm install) → 서버 재시작
 *
 * 설정(비밀키 등)은 .env 파일에 두세요. 추적되지 않으므로 git pull 과 충돌하지 않습니다.
 * 폴링 간격: DEPLOY_POLL_MS (기본 30000ms)
 *
 * 실행: node scripts/autodeploy.js   (또는 scripts\start-auto.bat 더블클릭)
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

require('../server/loadenv').loadEnv(); // .env → process.env (자식에게도 그대로 상속됨)

const ROOT = path.join(__dirname, '..');
const POLL_MS = Math.max(5000, Number(process.env.DEPLOY_POLL_MS) || 30000);

function git(args) {
  return execSync(`git ${args}`, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  })
    .toString()
    .trim();
}

let branch;
try {
  branch = git('rev-parse --abbrev-ref HEAD');
} catch (e) {
  console.error('[autodeploy] git 저장소가 아니거나 git 이 설치되지 않았습니다:', e.message);
  process.exit(1);
}

console.log('╔══════════════════════════════════════════════╗');
console.log('║  DOPAMINE 자동 배포 감시자                    ║');
console.log('╚══════════════════════════════════════════════╝');
console.log(`[autodeploy] 브랜치 "${branch}" 감시 · ${Math.round(POLL_MS / 1000)}초마다 새 커밋 확인`);

let child = null;
let stopping = false; // 우리가 의도적으로 재시작/종료하는 중인가

function startServer() {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => {
    if (stopping) return; // 재시작 중이면 무시
    console.error(`[autodeploy] 서버가 예기치 않게 종료됨(code=${code}). 5초 후 재시작합니다.`);
    setTimeout(startServer, 5000);
  });
}

function restartServer() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      startServer();
      return resolve();
    }
    stopping = true;
    child.once('exit', () => {
      stopping = false;
      startServer();
      resolve();
    });
    child.kill(); // SIGTERM
    setTimeout(() => {
      try {
        if (child && child.exitCode === null) child.kill('SIGKILL');
      } catch {
        /* 이미 종료됨 */
      }
    }, 4000);
  });
}

function pkgSnapshot() {
  try {
    return fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  } catch {
    return '';
  }
}

async function checkForUpdate() {
  if (stopping) return;
  try {
    git(`fetch --quiet origin ${branch}`);
    const local = git('rev-parse HEAD');
    const remote = git(`rev-parse origin/${branch}`);
    if (local === remote) return;

    console.log(`\n[autodeploy] 새 커밋 감지: ${local.slice(0, 7)} → ${remote.slice(0, 7)} · 업데이트 시작`);
    const pkgBefore = pkgSnapshot();
    // 로컬이 깔끔할 때만 안전하게 당긴다 (충돌 방지)
    git(`pull --ff-only origin ${branch}`);

    if (pkgSnapshot() !== pkgBefore) {
      console.log('[autodeploy] package.json 변경 감지 → npm install');
      try {
        execSync('npm install', { cwd: ROOT, stdio: 'inherit', timeout: 300000 });
      } catch (e) {
        console.error('[autodeploy] npm install 실패(그래도 재시작 진행):', e.message);
      }
    }

    console.log('[autodeploy] 서버 재시작 중...');
    await restartServer();
    console.log('[autodeploy] ✅ 업데이트 완료\n');
  } catch (e) {
    // ff-only 실패(로컬이 갈라짐)·네트워크 오류 등 → 다음 주기에 재시도
    console.error('[autodeploy] 업데이트 건너뜀(다음 주기 재시도):', String(e.message).split('\n')[0]);
  }
}

function shutdown() {
  stopping = true;
  if (child && child.exitCode === null) child.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startServer();
setInterval(checkForUpdate, POLL_MS);
