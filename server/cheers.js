/**
 * 관전자·플레이어 이모지 응원
 * ────────────────────────────
 * 임의 텍스트 주입을 막기 위해 허용된 이모지 목록만 방송한다.
 * 클라이언트의 응원 바(cheer bar)와 순서·구성이 일치해야 한다.
 */
const CHEERS = ['👏', '🔥', '🎉', '😂', '😮', '❤️', '😱', '💪', '🍀', '🙏'];
const CHEER_SET = new Set(CHEERS);

/** 허용 목록에 있는 이모지면 그대로, 아니면 null */
function sanitizeCheer(emoji) {
  const e = String(emoji || '').trim();
  return CHEER_SET.has(e) ? e : null;
}

module.exports = { CHEERS, sanitizeCheer };
