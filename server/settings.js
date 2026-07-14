/**
 * 런타임 설정 저장소 (data/settings.json) — 관리자 페이지에서 즉시 바꿀 수 있는 값들.
 * 기본값은 config.js / 환경변수에서 오고, 관리자가 바꾸면 파일에 저장되어 재시작해도 유지된다.
 * game.js·maps.js·/api/config 가 여기서 live 로 읽으므로 서버 재시작 없이 반영된다.
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('./security');
const config = require('./config');

const DATA_FILE = path.join(__dirname, '..', 'data', 'settings.json');
const DEFAULT_DONATION_URL = 'https://qr.kakaopay.com/Ej8euQo2R';
const MAP_DAILY_DEFAULT =
  process.env.MAP_DAILY_LIMIT !== undefined ? Math.max(0, Number(process.env.MAP_DAILY_LIMIT) || 0) : 10;

const DEFAULTS = {
  donationUrl: process.env.DONATION_URL || DEFAULT_DONATION_URL,
  donationLabel: process.env.DONATION_LABEL || '💛 서버비 후원하기 (카카오페이)',
  timeScale: config.TIME_SCALE,
  itemIntroMs: config.ITEM_INTRO_MS,
  shuffleAutoDropMs: config.SHUFFLE_AUTO_DROP_MS,
  mapDailyLimit: MAP_DAILY_DEFAULT,
};

class SettingsStore {
  constructor() {
    this.data = { ...DEFAULTS };
    try {
      const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      this.data = { ...this.data, ...j };
    } catch {
      /* 파일 없으면 기본값 */
    }
  }

  get(k) {
    return this.data[k];
  }
  all() {
    return { ...this.data };
  }

  /** 검증 후 병합·저장 → {ok, settings} | {ok:false, error} */
  update(patch = {}) {
    const d = { ...this.data };
    const num = (v, min, max, label) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label}은(는) ${min}~${max} 이어야 합니다.`);
      return Math.round(n);
    };
    try {
      if (patch.donationUrl !== undefined) d.donationUrl = String(patch.donationUrl).trim().slice(0, 300);
      if (patch.donationLabel !== undefined)
        d.donationLabel = String(patch.donationLabel).trim().slice(0, 60) || DEFAULTS.donationLabel;
      if (patch.timeScale !== undefined) d.timeScale = num(patch.timeScale, 1, 20, '낙하 배속');
      if (patch.itemIntroMs !== undefined) d.itemIntroMs = num(patch.itemIntroMs, 0, 30000, '아이템 소개 시간(ms)');
      if (patch.shuffleAutoDropMs !== undefined)
        d.shuffleAutoDropMs = num(patch.shuffleAutoDropMs, 1000, 30000, '자동 낙하 시간(ms)');
      if (patch.mapDailyLimit !== undefined) d.mapDailyLimit = num(patch.mapDailyLimit, 0, 1000, '하루 맵 제한');
    } catch (e) {
      return { ok: false, error: e.message };
    }
    this.data = d;
    try {
      atomicWriteJSON(DATA_FILE, this.data);
    } catch (e) {
      return { ok: false, error: '저장 실패: ' + e.message };
    }
    return { ok: true, settings: this.all() };
  }
}

module.exports = new SettingsStore(); // 싱글턴
