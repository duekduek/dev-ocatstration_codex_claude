# dev-ocatstration_codex_claude (`devagent`)

**기획·리뷰 담당과 개발 담당 AI가 나눠 일하는** 멀티 에이전트 개발 환경을 프로젝트마다 한 번에 만들어 주는 CLI와 GUI입니다. 기본값은 기획·리뷰 Codex, 개발 Claude이며, 역할마다 Codex/Claude와 모델을 바꿀 수 있습니다.

- 에이전트는 **Docker 컨테이너 안에서만** 실행됩니다. 컨테이너에는 프로젝트 폴더만 연결되므로 PC의 다른 파일은 건드리지 못합니다.
- Codex가 요구사항을 phase 단위로 계획하고, phase마다 `claude -p`에 개발을 맡긴 뒤 결과를 검토합니다. Claude는 필요하면 서브 에이전트를 써서 병렬로 개발합니다.
- phase가 통과하면 **커밋하고 GitHub에 push**합니다. 이어서 GitHub Actions 빌드 결과를 확인합니다.
- 모델(Codex·Claude), 플랫폼, 저장소 공개 여부는 설정 파일 하나(`devagent.config.json`)로 관리합니다.

## 요구 사항
- Node 18 이상, git, Docker Desktop
- 설치 상태는 `devagent doctor`로 점검할 수 있습니다.

## 처음 시작하기 — Claude Code에 이렇게 말하세요

Claude Code에서 개발할 폴더를 열고, 아래 문장을 그대로 붙여넣으면 됩니다.

> github.com/duekduek/dev-ocatstration_codex_claude 를 설치해서 이 폴더에 Codex랑 Claude로 개발 환경 만들어줘. 설치 방법은 그 저장소 README를 따라줘.

Claude가 다음을 순서대로 진행합니다.
1. devagent를 설치하고 스킬을 등록합니다.
2. Node, git, Docker를 점검합니다. 없는 도구는 설치해도 되는지 묻고 설치합니다.
3. 플랫폼, 역할별 도구, 모델을 정합니다.
4. 로그인, 저장소 생성, 개발 시작까지 이어서 진행합니다.

설치한 다음부터는 `/devagent`를 입력하지 않아도 이렇게 말하면 됩니다.
- "Codex랑 Claude로 개발 환경 만들어줘" / "이 폴더에서 멀티 에이전트 개발 시작해"
- "개발 담당을 Codex로 바꾸고 모델은 gpt-6.1-sol로 해줘"
- "요구사항 문서 같이 써줘" / "어디까지 진행됐어?"

> **Claude에게 (이 README를 읽고 설치를 맡은 경우):** 아래 순서로 진행하세요.
> 1. 저장소를 `~/.devagent/app`에 clone합니다. Windows에서는 `%USERPROFILE%\.devagent\app`입니다.
> 2. `node ~/.devagent/app/bin/devagent.js install-skill`로 스킬을 설치합니다.
> 3. 설치된 스킬 파일 `~/.claude/skills/devagent/SKILL.md`를 읽고 그 절차대로 진행합니다.
>
> 시스템에 도구를 설치하는 작업과 로그인은 사용자 확인을 받은 뒤에만 합니다.

### 플러그인으로 설치

`/plugin`은 사용자가 직접 입력하는 명령입니다. 아래 두 줄을 입력한 뒤 `/devagent`를 실행하세요.
```
/plugin marketplace add duekduek/dev-ocatstration_codex_claude
/plugin install devagent@devagent-marketplace
```
스킬이 차례로 진행합니다.
- 컴퓨터에 devagent가 없으면 `~/.devagent/app`에 설치합니다.
- Node, git, Docker가 없으면 설치합니다. 설치 전에 한 번 확인을 받습니다.
- 플랫폼별로 무엇을 어디서 실행할 수 있는지 안내합니다.
- 프로젝트 설정, 로그인, 저장소 생성, 개발 시작까지 이어서 진행합니다.

skills CLI로 설치할 수도 있습니다: `npx skills add duekduek/dev-ocatstration_codex_claude`

## 직접 설치
```bash
git clone https://github.com/duekduek/dev-ocatstration_codex_claude.git && cd dev-ocatstration_codex_claude
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

### 바로가기 (Windows)
`scripts/devagent-gui.cmd <프로젝트 폴더>`는 Docker Desktop이 꺼져 있으면 켜고, 엔진이 준비될 때까지 기다린 뒤 GUI를 엽니다. 바탕화면 바로가기는 이 스크립트를 대상으로 만들면 됩니다. GUI가 이미 켜져 있으면 브라우저만 엽니다.

### 웹 화면 (`devagent gui`, http://127.0.0.1:4317)
- **진행** 탭
  - Phase 카드: 상태가 대기 → 개발 중 → 검토 중 → 수정 중 → 완료로 바뀌고, 세부 작업과 보고서·리뷰·커밋이 함께 보입니다. phase가 끝나면 알림이 뜹니다.
  - **실시간 작업**: 기획 담당과 개발 담당이 지금 실행하는 명령과 수정 중인 파일을 보여줍니다.
  - **대화창**: 기획 담당의 질문에 웹에서 바로 답할 수 있습니다.
  - **▶ 개발 시작**: 이 버튼을 누르면 기획 담당이 확인 질문 없이 끝까지 진행합니다. 꼭 필요한 결정이 있을 때만 `[질문]`으로 묻고, 모든 phase가 끝나면 `[완료]`로 멈춥니다.
- **문서** 탭: 요구사항, 계획, 보고서, 리뷰를 보고 편집합니다.
- **설정** 탭: 역할별 AI·모델·추론 강도, 프로젝트 설정, 로그인·저장소를 관리합니다.
- **상단 바**: Codex와 Claude의 5시간·주간 남은 사용량을 보여줍니다. 값은 실제 실행 기록에서 읽습니다.

모델 변경 예시:
```bash
devagent set developer.model opus
devagent set planner.model gpt-5.5
devagent set planner.reasoning xhigh
devagent set planner.tool claude       # 기획도 Claude로
devagent set developer.tool codex      # 개발을 Codex로
```

## 로그인

`devagent login`은 **PC에 이미 로그인된 계정을 가져올 수 있으면 가져옵니다.** 가져오지 못한 계정만 직접 로그인하면 됩니다. 로그인 정보는 `devagent-*` Docker 볼륨에 저장되어 모든 프로젝트가 같이 씁니다.

| 계정 | PC에서 가져오기 | 가져오지 못하면 |
|---|---|---|
| Codex | O (`~/.codex/auth.json`이 있을 때) | 기기 코드 로그인. ChatGPT 보안 설정에서 기기 코드 로그인을 허용해야 합니다. 또는 PC에서 `codex login`을 먼저 하세요. |
| GitHub | O (PC의 `gh`가 로그인되어 있을 때. 토큰은 화면에 출력하지 않고 전달합니다) | github.com/login/device 에서 코드 입력 |
| Claude | **X** | 컨테이너에서 링크를 열어 로그인하고 코드를 붙여넣습니다 |

Claude를 가져오지 않는 이유: Claude 로그인 토큰은 사용처마다 갱신(회전)됩니다. 그래서 복사본은 곧 만료되고 갱신도 되지 않습니다. 직접 로그인은 PC마다 한 번만 하면 됩니다.

가져오기를 끄려면 `devagent login --no-import`를 쓰세요.

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
- `docs/agents/PLANNER.md`, `docs/agents/DEVELOPER.md`: 기획 담당/개발 담당 역할 지시 (기획 → 개발 요청 → 검토 → 커밋·push)
- `AGENTS.md`(Codex), `CLAUDE.md`(Claude): 각 도구가 맡은 역할 문서를 가리키는 안내
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
