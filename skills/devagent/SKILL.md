---
name: devagent
description: devagent(기획/리뷰 담당 + 개발 담당 AI, 기본 Codex+Claude, Docker 격리, phase별 GitHub push) 프로젝트를 설정·실행하도록 돕는다. 사용자가 "devagent", "codex랑 claude로 개발 환경 만들어줘", "멀티 에이전트 개발 시작", "도커에서 codex/claude 돌리기", "개발 담당/기획 담당 바꿔줘", "모델 바꿔줘", "요구사항 문서 같이 써줘", "어디까지 진행됐어"를 말하거나 /devagent 를 부를 때 사용. 환경 점검, Docker 등 누락 도구 설치 안내, 플랫폼별(iOS/Android 등) 실행 가능 범위 안내, init/login/repo/start 진행을 담당한다.
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
2. **받기.** 공개 저장소이므로 인증 없이 받을 수 있다.
   - `git clone https://github.com/duekduek/dev-ocatstration_codex_claude.git ~/.devagent/app`
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
- 역할별 도구: 기획/검토 기본 codex, 개발 기본 claude (`--planner-tool`, `--dev-tool`로 바꿀 수 있음, 같은 도구로 둘 다 맡겨도 됨)
- Claude 모델 — sonnet(기본, 사용량 절약) / opus(고품질, Pro 요금제는 한도가 빨리 참) / haiku
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
- PC에 로그인된 Codex(`~/.codex/auth.json`)와 GitHub(`gh auth token`)는 자동으로 가져온다. Claude는 토큰이 사용처마다 갱신되어 복사가 안 되므로 컨테이너에서 직접 로그인한다.
- Codex를 못 가져오면 기기 코드 로그인 — "기기 코드 로그인을 활성화하라"는 메시지가 나오면 ChatGPT 보안 설정에서 허용하거나, 호스트에서 먼저 `codex login`을 하고 다시 `devagent login`을 실행하라고 안내.
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
- 사용 한도에 걸리면 다른 도구로 역할을 넘기고, 둘 다 막히면 먼저 풀리는 시각까지 기다렸다가 자동으로 이어간다 (아래 7단계).

GUI를 원하면: `devagent gui --dir <폴더>` (브라우저에서 설정/로그인/시작 버튼 제공).

## 7. 사용 한도 — 초기화·충전했는데 계속 "한도 소진"일 때

devagent는 한도 정보를 계정 단위로 두 파일에 기록하고, 기록된 시각(`until`/`resetsAt`)까지는 그 도구를 쓰지 않는다. 그래서 사용자가 한도를 초기화하거나 크레딧을 충전해도 **기록이 남아 있으면 계속 대기**한다.

- `~/.devagent/limits.json` — 도구별 `{ until, message, at }`. 실행 전 판단에 쓴다.
- `~/.devagent/usage.json` — 상단 사용량 표시용 `{ five, week, exhausted, retryAt }`. 시작할 때 이 값으로 limits.json을 **다시 채우므로** 둘 다 지워야 한다.

순서:
1. **먼저 도구가 실제로 풀렸는지 컨테이너에서 직접 확인한다.** 기록만 지우고 시작하면 곧바로 다시 막힌다.
   ```bash
   docker run --rm -v devagent-claude-home:/home/node/.claude devagent-<프로젝트> sh -c "claude -p 'say ok'"
   docker run --rm -v devagent-codex-home:/home/node/.codex devagent-<프로젝트> sh -c "codex exec --skip-git-repo-check 'say ok'"
   ```
   `ok`가 오면 풀린 것. "hit your usage limit … try again at HH:MM"이면 실제로 아직 막힌 것이다(시각은 UTC일 수 있음 → 현지 시각으로 바꿔 안내).
2. 풀린 도구만 두 파일에서 지운다 (예: claude).
   ```bash
   node -e "const h=require('os').homedir()+'/.devagent/',fs=require('fs'),t='claude';const L=JSON.parse(fs.readFileSync(h+'limits.json','utf8'));delete L[t];fs.writeFileSync(h+'limits.json',JSON.stringify(L));const g=JSON.parse(fs.readFileSync(h+'usage.json','utf8'));if(g[t]){delete g[t].exhausted;delete g[t].retryAt;for(const w of ['five','week'])if(g[t][w])g[t][w].used=0}fs.writeFileSync(h+'usage.json',JSON.stringify(g))"
   ```
3. GUI를 새로고침하고 ▶(이어서 진행)을 누른다. 진행 로그에 기획 담당 명령이 찍히는지 확인한다.

안내할 점:
- Codex는 **ChatGPT 계정 로그인**으로 돈다. platform.openai.com의 **API 크레딧**을 충전해도 반영되지 않는다. ChatGPT 쪽 크레딧/요금제(chatgpt.com/settings/usage)만 적용된다.
- 자동 재개(대기 후 이어가기)는 ▶와 달리 Docker를 켜지 않을 수 있다. 재개 시각에 Docker가 꺼져 있으면 "docker API 연결 실패"로 멈추므로 ▶를 다시 누른다.

## 8. 에이전트용 스킬 추가

호스트에 설치한 스킬(`~/.claude/skills`, `~/.agents/skills`)은 컨테이너 안 에이전트에게 보이지 않는다. 컨테이너는 공유 볼륨을 홈으로 쓰므로 볼륨에 복사한다 (모든 devagent 프로젝트에 적용).

```bash
npx skills add <owner/repo@skill> -g -y      # 호스트에 먼저 설치 (설치 수·출처 확인 후)
docker run --rm -v ~/.agents/skills/<skill>:/src:ro -v devagent-claude-home:/c -v devagent-codex-home:/x devagent-<프로젝트> \
  sh -c "mkdir -p /c/skills /x/skills && cp -r /src /c/skills/<skill> && cp -r /src /x/skills/<skill>"
```

스킬을 쓰게 하려면 기획 담당에게 보내는 지시(질의 탭)에 스킬 이름을 적는다. 호스트에서 스킬을 업데이트하면 다시 복사해야 한다.

## 주의

- 에이전트는 컨테이너 안에서 권한 확인 없이 실행된다(컨테이너가 격리 역할). 호스트에서 직접 `codex --dangerously-bypass-approvals-and-sandbox`나 `claude --permission-mode bypassPermissions`를 실행하라고 안내하지 않는다.
- 사용자의 이메일·계정 정보를 출력하거나 외부로 보내지 않는다.
