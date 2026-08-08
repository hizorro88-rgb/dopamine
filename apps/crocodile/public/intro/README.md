# 🎞 실사 오프닝 영상 넣는 곳

이 폴더에 mp4 파일을 넣으면, 게임 시작 시 **시네마틱 컷씬 대신 이 영상이 재생**됩니다.
영상이 끝나면(또는 "건너뛰기" 누르면) 포효 연출과 함께 실제 게임으로 페이드됩니다.
파일이 없는 캐릭터는 기존 컷씬(악어=심연 부상, 상어=죠스, 티라노=쿵쾅, 몬스터=번개)을 그대로 씁니다.

## 파일 이름 (캐릭터별, 정확히 이 이름으로)

| 파일 | 캐릭터 |
|------|--------|
| `crocodile.mp4` | 🐊 악어 |
| `shark.mp4` | 🦈 상어 |
| `dino.mp4` | 🦖 티라노사우루스 |
| `monster.mp4` | 👹 몬스터 |

## 권장 스펙

- **길이**: 5~8초 (20초 넘으면 자동 컷)
- **화면비**: 세로 9:16 (720×1280 이상) — 가로 영상도 되지만 좌우가 잘림
- **코덱**: H.264 mp4 (모바일 사파리/크롬 호환 최우선)
- **용량**: 5~10MB 이하
- **소리**: 포함 OK — 자동재생이 막히면 무음으로 자동 전환
- ⭐ **마지막 장면은 반드시 "입을 쫙 벌리고 카메라로 달려드는" 컷**으로 — 영상이 끝나면 입 벌린 게임 화면으로 이어지므로 이렇게 해야 전환이 자연스럽다

## AI 영상 생성 프롬프트

Sora(ChatGPT) / Veo(Gemini) / Kling / Runway 등에 붙여넣기. 세로 9:16 옵션을 켜고 생성.
같은 프롬프트로 2~3번 뽑아 가장 좋은 것을 고르는 걸 추천.

### 🐊 악어 — crocodile.mp4

```
Vertical 9:16 photorealistic cinematic footage. Night swamp, pitch-dark murky
water, faint moonlight, thin mist. 0-2s: dead-calm water; far away, two amber
crocodile eyes and nostrils silently break the surface, ripples spreading.
2-4s: the crocodile glides straight toward the camera — only eyes and armored
back visible — wake widening, closer and closer. 4-6s: it explodes upward
filling the frame, jaws snapping wide open toward the lens, water spray
flying, dark red throat visible. Ends frozen on open jaws lunging at the
camera. Camera low at water level. Hyper-realistic scaly skin, dramatic rim
lighting, 24fps film look. No text, no watermark, no people.
```

### 🦈 상어 — shark.mp4

```
Vertical 9:16 photorealistic cinematic footage. Open ocean at dusk, dark
blue-grey water. 0-2s: a great white shark's dorsal fin surfaces far away and
slices across the frame left to right, leaving a wake. 2-4s: the fin circles
back much closer, cutting the surface fast, tension building. 4-5s: the fin
silently sinks below; still water; eerie pause. 5-7s: the great white erupts
from the water straight at the camera, jaws wide open showing rows of
triangular teeth, spray everywhere. Ends frozen on open jaws filling the
frame. Camera just above the waterline. Jaws-movie suspense, hyper-realistic,
subtle film grain. No text, no watermark, no people, no boat.
```

### 🦖 티라노 — dino.mp4

```
Vertical 9:16 photorealistic cinematic footage. Jungle swamp at night, rain
and mist. 0-2s: camera at ground level beside shallow water; distant heavy
footsteps boom, water rings ripple with each impact, birds scatter from
trees. 2-4s: trees part — a Tyrannosaurus rex charges directly toward the
camera through the shallows, each stomp throwing splashes and shaking the
frame. 4-6s: it halts right in front of the lens and roars with jaws wide
open, saliva strings between teeth, breath fogging the lens. Ends frozen on
open jaws at the camera. Camera shakes on every footstep. Jurassic-movie
style, hyper-realistic scaly skin, cinematic lighting. No text, no watermark,
no people.
```

### 👹 몬스터 — monster.mp4

```
Vertical 9:16 photorealistic cinematic horror footage. Black stormy lake at
night, heavy rain. 0-2s: total darkness; two glowing red eyes ignite far away
above the water and blink once. 2-4s: lightning flash — a huge horned monster
silhouette is suddenly much closer; darkness again; a second flash — closer
still, filling half the frame. 4-6s: a final massive lightning strike reveals
the demonic creature right at the camera, roaring, mouth full of long sharp
teeth, rain streaking through the frame. Ends frozen on open jaws at the
camera. Thunder-lit horror atmosphere, hyper-realistic. No text, no
watermark, no people.
```

### 짧은 버전 (글자수 제한 있는 도구용)

- 🐊 `Photorealistic vertical 9:16: crocodile eyes glide across dark night swamp water toward camera, then it bursts up with jaws wide open at the lens, water spraying. Ends on open jaws. 6s, cinematic, no text.`
- 🦈 `Photorealistic vertical 9:16: great white shark fin slices dark water, circles closer, sinks — pause — then shark erupts at camera jaws wide open. Jaws-style. Ends on open jaws. 7s, cinematic, no text.`
- 🦖 `Photorealistic vertical 9:16: T-rex charges through night jungle swamp toward camera, ground shaking each stomp, then roars jaws wide open at lens. Ends on open jaws. 6s, cinematic, no text.`
- 👹 `Photorealistic vertical 9:16 horror: red glowing eyes in storm darkness, each lightning flash the horned monster teleports closer, final flash reveals it roaring at camera. Ends on open jaws. 7s, no text.`

## 용량이 크면 (선택)

ffmpeg 이 있으면 이 한 줄로 압축:

```bash
ffmpeg -i input.mp4 -vf scale=720:1280 -c:v libx264 -crf 26 -preset slow -an output.mp4
```

(`-an` 은 소리 제거 — 소리를 살리려면 `-c:a aac -b:a 96k` 로 교체)

## 적용 방법

1. 생성한 mp4 를 이 폴더에 캐릭터 이름으로 저장
2. git 에 커밋·푸시 (또는 서버 맥의 이 폴더에 직접 복사)
3. 끝 — 코드 수정 불필요. 다음 게임 시작부터 자동 재생
