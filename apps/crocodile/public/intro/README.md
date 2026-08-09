# 🎞 실사 오프닝 영상 넣는 곳

이 폴더에 mp4 파일을 넣으면, 게임 시작 시 **시네마틱 컷씬 대신 이 영상이 재생**됩니다.
영상이 끝나면(또는 "건너뛰기" 누르면) 포효 연출과 함께 실제 게임으로 페이드됩니다.
파일이 없는 캐릭터는 기존 컷씬(악어=심연 부상, 상어=죠스, 티라노=쿵쾅)을 그대로 씁니다.

## 파일 이름 (캐릭터별, 정확히 이 이름으로)

| 파일 | 캐릭터 |
|------|--------|
| `crocodile.mp4` | 🐊 악어 |
| `shark.mp4` | 🦈 상어 |
| `dino.mp4` | 🦖 티라노사우루스 |

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

## 💥 물기 엔딩 영상 (당첨 순간)

함정 이빨을 눌러 **게임이 끝나는 순간**, `{캐릭터}-bite.mp4` 가 있으면 그 영상이 재생됩니다.
영상이 끝나면 입 다문 화면 + 붉은 플래시 → 결과 화면으로 이어집니다. 없으면 기존 SVG 물기 연출.

| 파일 | 캐릭터 |
|------|--------|
| `crocodile-bite.mp4` | 🐊 악어 물기 |
| `shark-bite.mp4` | 🦈 상어 물기 |
| `dino-bite.mp4` | 🦖 티라노 물기 |

⭐ **1인칭(POV)으로 "입이 카메라를 덮치며 콱 닫히고 → 화면이 암전"** 으로 끝나야
결과 화면 전환이 자연스럽습니다. 3~5초면 충분.

### 🐊 악어 물기 — crocodile-bite.mp4

```
Vertical 9:16 photorealistic cinematic POV footage, 4 seconds. Camera floats
at water level in a dark night swamp. A giant crocodile's jaws are wide open
filling the entire frame, dark red throat and sharp teeth visible, water
dripping. 0-2s: the jaws quiver, drool falling, tension. 2-4s: the jaws SNAP
shut directly onto the camera with a violent lunge, water exploding — cut to
black. Ends on black. Hyper-realistic, dramatic. No text, no watermark.
```

### 🦈 상어 물기 — shark-bite.mp4

```
Vertical 9:16 photorealistic cinematic POV footage, 4 seconds. Camera just
above dark ocean water at dusk. A great white shark's open jaws fill the
frame, rows of triangular teeth, pink gums. 0-2s: the shark rises closer,
jaws widening. 2-4s: the jaws SNAP shut over the camera with spray flying —
cut to black. Ends on black. Jaws-movie style, hyper-realistic. No text, no
watermark.
```

### 🦖 티라노 물기 — dino-bite.mp4

```
Vertical 9:16 photorealistic cinematic POV footage, 4 seconds. Ground-level
camera in a night jungle swamp. A Tyrannosaurus rex head looms above with
jaws wide open, saliva strings between banana-sized teeth. 0-2s: it roars and
lunges down toward the camera. 2-4s: the jaws SNAP shut onto the lens,
shaking violently — cut to black. Ends on black. Jurassic-movie style,
hyper-realistic. No text, no watermark.
```

### 짧은 버전 (글자수 제한 있는 도구용)

- 🐊 `Photorealistic vertical 9:16: crocodile eyes glide across dark night swamp water toward camera, then it bursts up with jaws wide open at the lens, water spraying. Ends on open jaws. 6s, cinematic, no text.`
- 🦈 `Photorealistic vertical 9:16: great white shark fin slices dark water, circles closer, sinks — pause — then shark erupts at camera jaws wide open. Jaws-style. Ends on open jaws. 7s, cinematic, no text.`
- 🦖 `Photorealistic vertical 9:16: T-rex charges through night jungle swamp toward camera, ground shaking each stomp, then roars jaws wide open at lens. Ends on open jaws. 6s, cinematic, no text.`

물기 엔딩 짧은 버전:

- 🐊 `POV vertical 9:16: giant crocodile jaws wide open fill frame in dark swamp, then SNAP shut onto camera, water exploding, cut to black. 4s, photorealistic, no text.`
- 🦈 `POV vertical 9:16: great white shark jaws fill frame above dark water, rows of teeth, then SNAP shut over camera, cut to black. 4s, photorealistic, no text.`
- 🦖 `POV vertical 9:16: T-rex head lunges down jaws wide open in night jungle, teeth SNAP shut onto camera, cut to black. 4s, photorealistic, no text.`

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
