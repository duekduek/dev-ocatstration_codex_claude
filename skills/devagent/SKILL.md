---
name: devagent
description: devagent(Codex 기획/리뷰 + Claude 개발, Docker 격리, phase별 GitHub push) 프로젝트를 설정·실행하도록 돕는다. 사용자가 "devagent", "codex랑 claude로 개발 환경 만들어줘", "멀티 에이전트 개발 시작", "도커에서 codex/claude 돌리기"를 말하거나 /devagent 를 부를 때 사용. 환경 점검, Docker 등 누락 도구 설치 안내, 플랫폼별(iOS/Android 등) 실행 가능 범위 안내, init/login/repo/start 진행을 담당한다.
---

# devagent 실행 도우미

목표: 사용자가 원하는 프로젝트 폴더에서 **devagent 설치 → 환경 점검 → 누락 도구 설치 → 설정 → 로그인 → 저장소 → 개발 시작**까지 막힘 없이 가게 한다. 한 번에 한 단계씩, 결과를 확인하며 진행한다.

아래에서 `devagent`는 0단계에서 찾은 실행 명령을 뜻한다. 모든 명령에 `--dir <프로젝트 폴더>`를 붙일 수 있다.

## 0. devagent 찾기 / 없으면 설치

다음 순서로 찾고, 처음 찾은 것을 `devagent` 명령으로 쓴다.
1. `devagent --help`가 동작하면 → `devagent`
2. `~/.devagent/app/bin/devagent.js`가 있으면 → `node ~/.devagent/app/bin/devagent.js`
3. 이 SKILL.md가 devagent 저장소 안에 있으면(플러그인 설치 등, `../../bin/devagent.js` 존재) → `node <그 경로>`

못 찾으면 설치한다. 설치 전에 "devagent를 ~/.devagent/app 에 설치할게요"라고 알리고 승인을 받는다.

1. **node(18+)와 git 확인.** 없으면 OS별 설치 명령을 보여주고 승인 후 실행한다.
   - Windows: `winget install -e --id OpenJS.NodeJS.LTS`, `winget install -e --id Git.Git` (설치 후 새 터미널이 필요할 수 있음 → PATH 갱신 안내)
   - Mac: `brew install node git` (brew 없으면 https://brew.sh 안내)
   - Linux: 배포판 패키지 명령 제시 (sudo는 사용자가 직접)
2. **받기.** 저장소는 private(`duekduek/dev-ocatstration_codex_claude`)이므로 GitHub 인증이 필요하다.
   - `gh`가 있고 로그인돼 있으면: `gh repo clone duekduek/dev-ocatstration_codex_claude ~/.devagent/app`
   - `gh`가 없으면 설치(`winget install -e --id GitHub.cli` / `brew install gh`) 후 사용자가 `gh auth login`을 직접 하도록 터미널에서 안내하고, 끝나면 위 clone 실행.
   - 접근 권한이 없다는 오류면: 저장소 소유자에게 협업자 초대를 받아야 한다고 알리고 중단.
   - 이미 `~/.devagent/app`이 있으면 `git -C ~/.devagent/app pull`로 업데이트.
3. **등록.** `npm link`는 전역 설치라 권한 문제가 날 수 있으므로 기본은 하지 않고 `node ~/.devagent/app/bin/devagent.js`로 사용한다. 사용자가 원하면 `cd ~/.devagent/app && npm link`.
4. `devagent --help`로 동작 확인.

(Windows에서 `~`는 `%USERPROFILE%`, 예: `C:\Users\<이름>\.devagent\app`)

## 1. 환경 점검 (항상 먼저)

```bash
devagent doctor --json --dir <폴더>
```

결과의 `checks` 중 `ok: false` 항목을 처리한다.

- **Docker 없음**: `fix`에 적힌 설치 명령을 사용자에게 보여주고 **설치해도 되는지 먼저 묻는다** (시스템 변경이므로). 승인 시 실행한다.
  - Windows: `winget install -e --id Docker.DockerDesktop`. WSL2가 없으면 `wsl --install`이 먼저 필요하고 재부팅해야 한다. 관리자 권한 창이 뜰 수 있다고 알린다. 설치 후 Docker Desktop을 한 번 실행해 약관 동의/엔진 시작을 사용자가 직접 하도록 안내한다.
  - Mac: `brew install --cask docker` (brew 없으면 docker.com 설치 파일 안내).
  - Linux: get.docker.com 스크립트 또는 배포판 패키지. sudo가 필요하므로 사용자가 직접 실행하도록 명령만 제시한다.
- **Docker 꺼짐**: Docker Desktop을 켜달라고 요청하고, 켜졌다고 하면 doctor를 다시 실행한다.
- **git/node 없음**: 같은 방식으로 설치 명령 제시 → 승인 후 실행.
- 설치/재부팅 후에는 반드시 doctor를 다시 돌려 `ready: true`를 확인한다.

## 2. 플랫폼별 실행 가능 범위 안내

프로젝트가 이미 있으면 doctor 결과의 `platformAdvice`, 없으면 사용자가 고른 플랫폼과 `host`로 판단해 **설정 전에** 분명히 말한다.

| 플랫폼 | Windows/Linux 호스트 | Mac 호스트 |
|---|---|---|
| ios | **컨테이너·이 PC에서 빌드/실행 불가.** GitHub Actions(macOS)로 빌드 확인만 하고, 실제 실행(시뮬레이터/실기기)은 **맥북에서** 저장소 clone → `xcodegen generate` → Xcode로 실행하라고 안내. private 저장소의 macOS Actions는 무료 분량을 10배로 소모함도 알림 | Actions로 빌드 확인 + 이 Mac의 Xcode로 실행 |
| android | 빌드 확인은 Actions, 실행은 호스트에 Android Studio 설치 후 | 동일 |
| flutter | 컨테이너에서 analyze/test. Android 실행은 호스트 Flutter+Android Studio, iOS 실행은 Mac 필요 | Mac에서 iOS/Android 모두 `flutter run` |
| react-native | 컨테이너에서 타입체크/테스트, 실행은 휴대폰 Expo Go | 동일 (+ iOS 시뮬레이터 가능) |
| web/python/go/java/rust | 컨테이너에서 빌드·테스트·실행 모두 가능 | 동일 |

사용자가 요구사항 명세를 가지고 있으면 내용을 보고 플랫폼을 추천한다 (예: "iOS 우선"이면 ios, 크로스플랫폼이면 flutter/react-native 제안). 단, 결정은 사용자에게 맡긴다.

## 3. 설정 (init)

사용자에게 다음을 확인한다 (기본값 제시):
- 프로젝트 이름(= GitHub 저장소 이름, 기본: 폴더명)
- 플랫폼: web, react-native, python, ios, android, flutter, go, java, rust
- Codex(기획/검토) 모델 — 비우면 Codex 기본값. 추론 강도 low/medium/high/xhigh (기본 high)
- Claude(개발) 모델 — sonnet(기본, 사용량 절약) / opus(고품질, Pro 요금제는 한도가 빨리 참) / haiku
- 저장소 private/public (기본 private), phase마다 push 여부, Actions 빌드 확인 여부
- 요구사항 명세 파일 경로 (기본 docs/SPEC.md). 이미 명세 파일이 있으면 그 경로를 쓴다.

```bash
devagent init <폴더> --yes --name <이름> --platform <플랫폼> --dev-model <모델> [--planner-model <모델>] [--reasoning high] [--visibility private] [--push-on phase] [--spec <파일>]
```

나중에 모델만 바꿀 때: `devagent set developer.model opus --dir <폴더>` (생성 파일 자동 갱신).

## 4. 로그인 (대화형 — 사용자가 직접)

로그인은 브라우저 인증·코드 입력이 필요하다. **비밀번호·토큰을 대신 입력하지 않는다.** 터미널 탭(가능하면 run_in_terminal)에서 실행해 사용자가 진행하게 하고, 각 단계에서 무엇을 하면 되는지 짧게 안내한다.

```bash
devagent login --dir <폴더>
```

- Docker 이미지 빌드 → 이미 로그인된 항목은 건너뜀. 로그인 정보는 모든 devagent 프로젝트가 공유(Docker 볼륨 devagent-*)하므로 한 번만 하면 된다.
- Codex: 호스트에 `~/.codex/auth.json`이 있으면 자동 복사. 없으면 기기 코드 로그인 — "기기 코드 로그인을 활성화하라"는 메시지가 나오면 ChatGPT 보안 설정에서 허용하거나, 호스트에서 먼저 `codex login`을 하고 다시 `devagent login`을 실행하라고 안내.
- Claude: 링크를 열어 로그인 → 받은 코드를 터미널에 붙여넣기.
- GitHub: 일회용 코드를 github.com/login/device 에 입력.
- 끝나면 `devagent status --dir <폴더>`로 세 항목 모두 O인지 확인.

## 5. 저장소

```bash
devagent repo --dir <폴더>
```

GitHub에 저장소를 만들고 첫 커밋을 push한다. 공개 저장소(public)를 고른 경우엔 실행 전에 한 번 더 확인한다.

## 6. 개발 시작

요구사항 명세 파일이 비어 있거나 템플릿 그대로면, 먼저 사용자와 함께 채운다.

```bash
devagent start --dir <폴더>
```

대화형이므로 터미널 탭에서 실행하고 사용자에게 넘긴다. 안내할 것:
- Codex가 먼저 docs/PLAN.md(phase 계획)를 만들고 승인을 요청한다 → 내용을 보고 승인.
- 이후 Codex가 phase마다 Claude에게 개발 요청 → 검토 → 통과 시 커밋/push(+Actions 빌드 확인)를 반복한다.
- 중단 후 재개: 같은 명령을 다시 실행하면 PLAN.md를 읽고 이어서 진행.
- 사용 한도에 걸리면 Codex가 멈추고 알린다. 한도가 풀린 뒤 다시 start.

GUI를 원하면: `devagent gui --dir <폴더>` (브라우저에서 설정/로그인/시작 버튼 제공).

## 주의

- 에이전트는 컨테이너 안에서 권한 확인 없이 실행된다(컨테이너가 격리 역할). 호스트에서 직접 `codex --dangerously-bypass-approvals-and-sandbox`나 `claude --permission-mode bypassPermissions`를 실행하라고 안내하지 않는다.
- 사용자의 이메일·계정 정보를 출력하거나 외부로 보내지 않는다.
