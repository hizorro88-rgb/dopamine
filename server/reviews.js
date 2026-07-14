/**
 * 맵 후기(커뮤니티) 저장소 (data/reviews.json 영구 저장)
 *
 * - 맵마다 별점(1~5) + 댓글을 남길 수 있다
 * - 같은 닉네임이 같은 맵에 다시 쓰면 이전 후기를 덮어쓴다
 * - 맵 목록 정렬용 점수는 베이지안 평균을 사용:
 *   후기 1개짜리 5점 맵이 후기 50개짜리 4.8점 맵을 이기지 않도록
 *   가상의 "기본 후기" PRIOR_COUNT 개(평점 PRIOR_MEAN)를 섞어서 계산한다.
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('./security');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'reviews.json');

const MAX_TEXT = 200;
const MAX_REVIEWS_PER_MAP = 500;
const PRIOR_MEAN = 3.5;
const PRIOR_COUNT = 3;

class ReviewStore {
  constructor() {
    this.byMap = {}; // mapId -> [{name, rating, text, at}]
    this.load();
  }

  load() {
    try {
      this.byMap = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
      this.byMap = {};
    }
  }

  persist() {
    atomicWriteJSON(DATA_FILE, this.byMap);
  }

  /** 후기 등록 (같은 이름은 덮어쓰기) */
  add({ mapId, name, rating, text } = {}) {
    const cleanName = String(name || '').trim().slice(0, 12);
    if (!cleanName) return { ok: false, error: '이름을 입력해주세요.' };
    const r = Math.round(Number(rating));
    if (!Number.isFinite(r) || r < 1 || r > 5)
      return { ok: false, error: '별점은 1~5점이어야 합니다.' };
    const cleanText = String(text || '').trim().slice(0, MAX_TEXT);

    const list = this.byMap[mapId] || [];
    const existing = list.findIndex((v) => v.name === cleanName);
    const review = { name: cleanName, rating: r, text: cleanText, at: Date.now() };
    if (existing >= 0) list[existing] = review;
    else {
      if (list.length >= MAX_REVIEWS_PER_MAP)
        return { ok: false, error: '이 맵의 후기가 가득 찼습니다.' };
      list.push(review);
    }
    this.byMap[mapId] = list;
    this.persist();
    return { ok: true };
  }

  /** 특정 맵의 후기 목록 (최신순) + 요약 */
  list(mapId) {
    const reviews = [...(this.byMap[mapId] || [])].sort((a, b) => b.at - a.at);
    return { ...this.summary(mapId), reviews };
  }

  /** 평균 별점/후기 수 */
  summary(mapId) {
    const list = this.byMap[mapId] || [];
    if (list.length === 0) return { avg: 0, count: 0 };
    const sum = list.reduce((s, v) => s + v.rating, 0);
    return { avg: Math.round((sum / list.length) * 10) / 10, count: list.length };
  }

  /** 정렬용 베이지안 점수 (후기 없으면 기본값) */
  score(mapId) {
    const list = this.byMap[mapId] || [];
    const sum = list.reduce((s, v) => s + v.rating, 0);
    return (sum + PRIOR_MEAN * PRIOR_COUNT) / (list.length + PRIOR_COUNT);
  }
}

module.exports = { ReviewStore };
