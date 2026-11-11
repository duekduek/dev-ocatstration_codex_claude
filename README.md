# dev-ocatstration_codex_claude (`devagent`)

**Codex가 기획·리뷰하고 Claude가 개발하는** 멀티 에이전트 개발 환경을 프로젝트마다 한 번에 만들어 주는 CLI와 GUI입니다.

- 에이전트는 **Docker 컨테이너 안에서만** 실행됩니다. 컨테이너에는 프로젝트 폴더만 연결되므로 PC의 다른 파일은 건드리지 못합니다.
- Codex가 요구사항을 phase 단위로 계획하고, phase마다 `claude -p`에 개발을 맡긴 뒤 결과를 검토합니다. Claude는 필요하면 서브 에이전트를 써서 병렬로 개발합니다.
- phase가 통과하면 **커밋하고 GitHub에 push**합니다. 이어서 GitHub Actions 빌드 결과를 확인합니다.
- 모델(Codex·Claude), 플랫폼, 저장소 공개 여부는 설정 파일 하나(`devagent.config.json`)로 관리합니다.

## 요구 사항
- Node 18 이상, git, Docker Desktop
- 설치 상태는 `devagent doctor`로 점검할 수 있습니다.

## 처음 시작하기 (가장 쉬운 방법)

Claude Code만 있으면 됩니다. 아래 두 줄로 플러그인을 설치한 뒤 `/devagent`를 실행하세요.
```
/plugin marketplace add duekduek/dev-ocatstration_codex_claude
/plugin install devagent@devagent-marketplace
```
스킬이 차례로 진행합니다.
- 컴퓨터에 devagent가 없으면 `~/.devagent/app`에 설치합니다.
- Node, git, Docker가 없으면 설치합니다. 설치 전에 한 번 확인을 받습니다.
- 플랫폼별로 무엇을 어디서 실행할 수 있는지 안내합니다.
- 프로젝트 설정, 로그인, 저장소 생성, 개발 시작까지 이어서 진행합니다.

저장소가 private이라 GitHub 접근 권한(협업자 초대)이 필요합니다.

## 직접 설치
```bash
git clone <이 저장소> && cd dev-ocatstration_codex_claude
npm link          # 'devagent' 명령 등록 (또는 node bin/devagent.js 로 실행)
devagent install-skill   # (선택) Claude Code 스킬 /devagent 설치
```

## 사용
```bash
devagent doctor                  # 환경 점검 + 플랫폼별 안내
devagent init my-app             # 대화형 설정 (플랫폼/모델/저장소)
cd my-app
# docs/SPEC.md 에 요구사항 작성
devagent login                   # 이미지 빌드 + Claude/Codex/GitHub 로그인 (한 번만)
devagent repo                    # GitHub 저장소(기본 private) 생성 + 첫 push
devagent start                   # Codex 실행 → 개발 시작/이어하기
```

GUI를 쓰려면 `devagent gui`를 실행하세요. `http://127.0.0.1:4317`에서 설정, 로그인, 저장소 생성, 개발 시작을 버튼으로 할 수 있습니다.

모델 변경 예시:
```bash
devagent set developer.model opus
devagent set planner.model gpt-5.5
devagent set planner.reasoning xhigh
```

## 플랫폼
`web`, `react-native`, `python`, `ios`, `android`, `flutter`, `go`, `java`, `rust`

| 플랫폼 | 컨테이너 안에서 | 빌드 확인 (Actions) | 실제 실행 |
|---|---|---|---|
| web / python / go / java / rust | 빌드·테스트·실행 | ubuntu | 컨테이너 (포트 노출) |
| react-native | 타입체크·테스트 | ubuntu | 휴대폰 Expo Go |
| flutter | analyze·test | ubuntu | 호스트의 Flutter (iOS는 Mac) |
| android | (JDK만 있음) | ubuntu + Android SDK | 호스트의 Android Studio |
| ios | 불가 (XcodeGen `project.yml`만 작성) | **macOS** | **Mac에서 Xcode** |

## 생성되는 파일
- `.devcontainer/Dockerfile`, `docker-compose.yml`: 개발 컨테이너. 로그인 정보는 `devagent-*` 볼륨에 저장되어 모든 프로젝트가 공유합니다.
- `AGENTS.md`: Codex에게 주는 지시입니다. 기획 → 개발 요청 → 검토 → 커밋·push 순서가 들어 있습니다.
- `CLAUDE.md`: Claude에게 주는 지시입니다. 개발 규칙과 보고서 작성 방법이 들어 있습니다.
- `.github/workflows/build-check.yml`: 플랫폼별 빌드 확인 워크플로입니다.
- `docs/SPEC.md`: 요구사항 템플릿입니다. 이미 있는 파일은 덮어쓰지 않습니다.

`devagent apply`(또는 `set`)를 실행하면 이 파일들이 다시 생성됩니다. 직접 수정하지 말고 설정을 바꾸세요.

## 주의
- 컨테이너 안에서는 Codex와 Claude가 권한 확인 없이 실행됩니다. 호스트에서 직접 이런 방식으로 실행하지 마세요.
- private 저장소에서 macOS Actions(iOS 빌드)를 쓰면 무료 분량이 10배로 소모됩니다.
- Claude Pro 요금제에서는 사용 한도에 걸릴 수 있습니다. 한도에 걸리면 Codex가 멈추고 알려줍니다. 한도가 풀린 뒤 `devagent start`를 다시 실행하면 이어서 진행합니다.

## 테스트
```bash
npm test     # 모든 플랫폼 init + docker compose 설정 검증
```
