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

- **길이**: 5~8초 (너무 길면 게임 템포가 죽어요. 20초 넘으면 자동 컷)
- **화면비**: 세로 9:16 (720×1280) 권장 — 게임이 세로 화면이라 `object-fit: cover` 로 꽉 채워짐. 가로 영상도 되지만 좌우가 잘림
- **코덱**: H.264 mp4 (모바일 사파리/크롬 호환 최우선)
- **용량**: 5~10MB 이하 (핸드폰에서 바로 로드돼야 함)
- **소리**: 포함 OK — 소리 켜고 재생 시도하고, 브라우저가 막으면 자동으로 무음 재생

## AI 영상 생성 프롬프트 (Sora / Veo / Kling / Runway 등에 붙여넣기)

**🐊 악어 (crocodile.mp4)**
> Photorealistic cinematic shot, vertical 9:16. A massive crocodile lurks beneath dark murky swamp water at night. Only its eyes and nostrils break the surface. It glides silently toward the camera, closer and closer. Suddenly it lunges up out of the water, jaws opening wide toward the camera, water exploding everywhere. Low angle, dramatic lighting, mist. 6 seconds.

**🦈 상어 (shark.mp4)**
> Photorealistic cinematic shot, vertical 9:16. A great white shark's dorsal fin slices through dark ocean water at dusk, passing left to right in the distance. It circles closer, fin cutting the surface. The fin sinks below. A beat of stillness. Then the shark erupts from the water toward the camera with jaws wide open, spray flying. Jaws-style suspense. 7 seconds.

**🦖 티라노 (dino.mp4)**
> Photorealistic cinematic shot, vertical 9:16. Jungle swamp at night. Heavy footsteps shake the ground, water ripples with each impact. Trees part as a Tyrannosaurus rex charges toward the camera through shallow water, each stomp splashing. It stops close and roars at the camera, jaws wide. Jurassic movie style, dramatic lighting. 6 seconds.

**👹 몬스터 (monster.mp4)**
> Photorealistic cinematic horror shot, vertical 9:16. Pitch black stormy lake. Two glowing red eyes appear far away in the darkness. Lightning flashes — a huge horned monster silhouette is suddenly much closer. Another flash — closer still. Final lightning strike reveals the creature right at the camera, roaring with a mouth full of sharp teeth. Thunder, rain. 7 seconds.

## 적용 방법

1. 생성한 mp4 를 이 폴더에 캐릭터 이름으로 저장
2. git 에 커밋·푸시 (또는 서버 맥의 이 폴더에 직접 복사)
3. 끝 — 코드 수정 불필요. 다음 게임 시작부터 자동 재생
