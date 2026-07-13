/**
 * ⚙️ 게임 설정 파일 — 값을 바꾸고 서버를 재시작하면 반영됩니다.
 * 환경변수로도 덮어쓸 수 있습니다 (예: TIME_SCALE=3 npm start).
 */

module.exports = {
  /**
   * 낙하 배속 (공의 속도) — 낙하가 시작되면 물리 시뮬레이션이
   * 실제 시간보다 이 배수만큼 빠르게 흐릅니다.
   *   1 = 실시간 (감상용, 느긋)
   *   5 = 기본값 (클래식 맵 기준 약 1~2초 레이스)
   *  10 = 아주 빠름 (아이템을 손으로 쓰기 어려운 수준)
   * 셔플·줄 자르기 단계는 항상 실시간이고, 아이템 지속시간·폭탄
   * 재생성·제한시간은 게임 시간 기준이라 배속을 바꿔도 밸런스가 유지됩니다.
   */
  TIME_SCALE: Number(process.env.TIME_SCALE) > 0 ? Number(process.env.TIME_SCALE) : 5,

  /**
   * 셔플 낙하 자동 시작 (ms) — 방장이 낙하 버튼을 누르지 않아도
   * 셔플 시작 후 이 시간이 지나면 자동으로 떨어집니다.
   */
  SHUFFLE_AUTO_DROP_MS:
    Number(process.env.SHUFFLE_AUTO_DROP_MS) > 0
      ? Number(process.env.SHUFFLE_AUTO_DROP_MS)
      : 5000,
};
