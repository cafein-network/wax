# wax 설치 안내

1. 인터넷에 연결되어 있다면 아래 "한 번 설치"만 따르면 됩니다. ZIP으로 설치하려면 [wax 사이트](https://wax.me2shop.com/#download)에서 플러그인 ZIP을 내려받습니다.
2. **모두 압축 풀기**를 실행하고, 내부에 `package.json`, `bin`, `.claude-plugin`이 있는 `wax` 폴더를 찾습니다. 이 폴더는 계속 같은 위치에 보관하세요.
3. Node.js 22 이상과 로그인된 Codex, Claude Code, Gemini CLI, Antigravity CLI 또는 GitHub Copilot CLI를 준비합니다. 플러그인은 `npm install` 없이 사용할 수 있습니다.

## 한 번 설치 (권장)

wax는 공개 저장소 [cafein-network/wax](https://github.com/cafein-network/wax)를 플러그인 마켓플레이스로 제공합니다. 도구마다 한 번만 등록하고 설치하면, 이후 모든 프로젝트에서 wax를 씁니다. 프로젝트마다 연결하거나 실행할 때마다 옵션을 붙일 필요가 없습니다. 쓰는 도구만 골라 실행하세요.

```sh
# Claude Code
claude plugin marketplace add cafein-network/wax
claude plugin install wax@wax

# Codex
codex plugin marketplace add cafein-network/wax
codex plugin add wax@wax

# GitHub Copilot CLI
copilot plugin marketplace add cafein-network/wax
copilot plugin install wax@wax

# Gemini CLI
gemini extensions install https://github.com/cafein-network/wax
```

- **업데이트**: Claude Code `claude plugin marketplace update wax` → `claude plugin update wax@wax`, Codex `codex plugin marketplace upgrade wax` → `codex plugin add wax@wax`, GitHub Copilot CLI `copilot plugin update wax@wax`, Gemini CLI `gemini extensions update wax`.
- **제거**: `claude plugin uninstall wax@wax`, `codex plugin remove wax@wax`, `copilot plugin uninstall wax@wax`, `gemini extensions uninstall wax`.
- 각 도구는 서로 다른 설정 위치에 설치되므로 충돌하지 않습니다. Antigravity CLI는 아래의 프로젝트 연결로 씁니다.

### 인터넷 없이(ZIP) 설치

압축을 푼 `wax` 폴더도 그대로 마켓플레이스입니다. 위 명령의 `cafein-network/wax` 자리에 폴더 경로를 넣으세요(예: `claude plugin marketplace add "/absolute/path/to/wax"`). 새 버전은 같은 경로의 폴더를 새 ZIP으로 바꾼 뒤 Claude Code는 `claude plugin update wax@wax`, Codex는 `codex plugin add wax@wax`를 다시 실행합니다. GitHub Copilot CLI는 폴더를 바로 읽어 다음 세션부터 적용됩니다. 폴더를 옮겼다면 각 도구에서 `plugin marketplace remove wax` 뒤 새 경로로 다시 등록하세요.

## Codex

Codex용 마켓플레이스는 `.agents/plugins/marketplace.json`에 정의되어 있으며, 저장소와 ZIP 모두 같은 루트의 wax 플러그인을 가리킵니다. Claude·Copilot용 목록도 함께 제공합니다.

### 마켓플레이스 등록·검색 오류

`marketplace 'wax' is already added from a different source`는 이전 ZIP 경로나 다른 Git 주소가 `wax`라는 이름으로 등록되어 있다는 뜻입니다. 먼저 `codex plugin marketplace list`로 출처를 확인하고, 공개 GitHub 저장소로 전환하려면 아래 명령을 한 줄씩 실행합니다. 앞 명령이 실패하면 다음 명령으로 넘어가지 말고 오류를 확인하세요.

```sh
codex plugin marketplace remove wax
codex plugin marketplace add cafein-network/wax
codex plugin add wax@wax
```

마켓플레이스 등록 제거는 작업 프로젝트의 `.wax`나 소스 파일을 삭제하지 않습니다.

등록 출처가 이미 `cafein-network/wax`인데 `plugin wax was not found in marketplace wax`가 나오면 목록을 갱신하고, 설치 가능한 플러그인에 `wax@wax`가 있는지 확인합니다.

```sh
codex plugin marketplace upgrade wax
codex plugin list --marketplace wax --available --json
codex plugin add wax@wax
```

목록에 `wax@wax`가 없으면 설치를 반복하지 말고 `codex --version`, `codex plugin marketplace list`와 위 목록 조회 결과를 함께 확인하세요. ZIP 출처는 Git 갱신 대신 이 정의가 포함된 새 ZIP을 같은 경로에 풀어야 합니다. 설치 뒤에는 새 Codex 세션을 시작합니다.

### 특정 프로젝트에만 연결

위의 한 번 설치를 권장합니다. 특정 프로젝트에만 연결하려면 압축을 푼 플러그인과 사용할 프로젝트의 실제 경로를 지정합니다(Antigravity CLI·GitHub Copilot CLI도 같은 연결을 읽습니다).

```sh
node "/absolute/path/to/wax/scripts/install-codex.mjs" --project "/absolute/path/to/your-project"
node "/absolute/path/to/wax/scripts/install-codex.mjs" --project "/absolute/path/to/your-project" --check
cd "/absolute/path/to/your-project"
codex
```

Windows PowerShell에서도 같은 Node 명령에 `C:\Tools\wax`, `C:\Projects\my-app` 같은 Windows 경로를 사용합니다. WSL에서는 `/mnt/c/...` 경로를 사용하세요. 설치는 프로젝트의 `.agents/skills`에 13개 스킬을 연결합니다. Linux·WSL에서는 심볼릭 링크, Windows에서는 디렉터리 junction을 사용하며 플러그인 원본 폴더를 계속 유지해야 합니다. 기존 다른 스킬·`AGENTS.md`·Codex 설정은 덮어쓰지 않습니다. `--check`는 설치 상태만 읽고, 누락·충돌이 있으면 종료 코드 1을 반환합니다.

새 Codex 세션의 `/skills`에서 확인한 뒤 대화창에서 사용합니다. `$`로 시작하는 아래 예시는 터미널 명령이 아닙니다.

```text
$wax:init
$wax:plan hello 첫 화면에 환영 문구를 추가해줘
$wax:design hello
$wax:implement hello
$wax:review hello
$wax:report hello
$wax:status hello
$wax:iterate hello 경계 조건 처리 개선
```

기록은 대상 프로젝트의 `.wax/features`에 저장되므로 Claude·Gemini·웹 서비스와 공유됩니다. 새 스킬이 보이지 않으면 Codex를 재시작하세요. 스킬을 찾지 못하는 버전은 Codex를 업데이트한 뒤 설치 확인 명령을 실행합니다.

## Claude Code

위의 한 번 설치(`claude plugin marketplace add` → `claude plugin install wax@wax`)를 권장합니다. 설치 없이 한 세션에서만 써 보려면 코딩할 프로젝트 디렉터리에서 플러그인 경로를 지정해 실행합니다.

```sh
claude --plugin-dir "/absolute/path/to/wax"
```

Windows PowerShell 예시:

```powershell
cd "C:\Projects\my-app"
claude --plugin-dir "C:\Tools\wax"
```

WSL에서 Claude Code를 실행한다면 Windows의 `C:\Tools\wax` 대신 `/mnt/c/Tools/wax`처럼 WSL 경로를 사용합니다.

`--plugin-dir`은 그 세션에서만 로드합니다. 한 번 설치했다면 옵션 없이 `claude`로 시작하고, 대화창에서 순서대로 실행하세요.

```text
/wax:init
/wax:plan hello 첫 화면에 환영 문구를 추가해줘
/wax:design hello
/wax:implement hello
/wax:review hello
/wax:report hello
```

`/wax:init`은 처음 한 번 세션 이름·맡을 작업·대시보드 열기·PM 지정을 묻고(엔터면 기본값) 팀 채널에 참여합니다. 같은 프로젝트의 다른 AI 세션은 `/wax:join`으로 참여합니다.

한 명령은 한 단계를 실행합니다. 실제 수정과 테스트는 호스트의 도구·권한을 사용합니다.

## Gemini CLI

**인증 안내(2026-10-20 확인):** 개인 Google 로그인으로 제공되던 Gemini CLI 이용은 2026-06-18 종료됐습니다(무료·Google AI Pro·Ultra 포함). 지원되는 API 인증 또는 기존 Gemini Code Assist Standard·Enterprise 라이선스가 필요하며, Google 전환 공지는 유료 API 키 이용과 개인 사용자의 Antigravity CLI 이전을 안내합니다. Standard·Enterprise 신규 구독 판매도 2026-10-09 중단됐습니다. 기존 구독은 계약과 별도 종료 일정에 따릅니다. [개인 계정 종료](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals) · [전환 안내](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) · [기업 구독 일정](https://docs.cloud.google.com/gemini/docs/codeassist/sunset)

```sh
gemini extensions link "/absolute/path/to/wax"
cd "/absolute/path/to/your-project"
gemini
```

새 세션에서 같은 `/wax:` 명령을 사용합니다. 이 릴리스의 실제 Gemini 세션 실행은 아직 검증하지 않았습니다.

## Antigravity CLI

Antigravity CLI(`agy`)는 프로젝트의 `.agents/skills`에 있는 스킬을 읽습니다. Codex와 같은 설치기로 연결합니다. 이미 Codex용으로 설치한 프로젝트는 다시 설치할 필요가 없습니다.

```sh
node "/absolute/path/to/wax/scripts/install-codex.mjs" --project "/absolute/path/to/your-project"
node "/absolute/path/to/wax/scripts/install-codex.mjs" --project "/absolute/path/to/your-project" --check
cd "/absolute/path/to/your-project"
agy
```

새 세션의 `/skills`에서 13개 스킬을 확인합니다. 처음에는 `/init`으로 시작합니다(자체 `/init`과 겹치면 "wax init 스킬로 시작해줘"). Antigravity CLI는 스킬을 슬래시 명령으로 바꾸므로 `/plan hello 첫 화면에 환영 문구를 추가해줘`처럼 스킬 이름으로 호출합니다. 실제 표시 이름은 `/skills` 목록을 따르세요. 같은 이름의 기본 명령이나 다른 스킬이 있으면 "wax plan 단계를 실행해줘"처럼 요청해도 됩니다. 이 릴리스의 실제 Antigravity CLI 세션 실행은 아직 검증하지 않았습니다.

`agy plugin install`과 `agy plugin import gemini`는 플러그인 파일을 별도 위치로 옮기거나 변환합니다. wax 스킬이 함께 제공하는 CLI(`bin`, `src`)를 찾지 못할 수 있으므로 위의 프로젝트 연결 방식을 사용하세요.

## GitHub Copilot CLI

GitHub Copilot CLI(`copilot`, Microsoft Copilot과 다른 GitHub의 코딩 도구)는 위의 한 번 설치(`copilot plugin marketplace add` → `copilot plugin install wax@wax`)로 모든 프로젝트에서 wax 스킬 13개를 씁니다. `copilot plugin list`의 Live Plugins에 `wax@wax`가 보이면 됩니다.

스킬은 이름을 밝혀 "wax plan 스킬로 login 이메일 로그인 기획해줘"처럼 요청합니다. GitHub Copilot CLI에는 `/status` 같은 자체 명령이 있어 `/status`만 입력하면 wax가 아닌 다른 기능이 실행될 수 있습니다. 처음 실행할 때 플러그인 폴더 파일을 읽는 승인 창이 뜨면 허용하세요. 프로젝트에 `.agents/skills`를 연결해 두어도 같은 이름은 프로젝트 쪽이 우선해 두 벌로 보이지 않습니다.

## 팀 대시보드

```sh
node "/absolute/path/to/wax/bin/wax.mjs" --project "/absolute/path/to/your-project" dashboard
```

브라우저에서 `http://127.0.0.1:4330/`을 엽니다. AI 세션에서는 처음에 `/wax:init`으로 시작하면 팀 채널 참여와 함께 첫 화면의 시작 가이드를 바로 열며, 다른 세션은 `/wax:join`으로 참여합니다. 각 도구에서 `/wax:pm`(대표에게 조언·업무 배정·진행 보고), `/wax:work`(배정 업무 수행), `/wax:chat`(세션 간 대화), `/wax:daily`(일일 업무보고)를 사용할 수 있습니다. Codex CLI의 AI 대화창에서는 `$wax:work <업무ID>`처럼 `$wax:<명령>` 형식을 사용합니다. `$`는 스킬 호출, `@`는 파일 첨부이며, wax 채널의 `@이름` 알림과 구분합니다. Antigravity CLI는 `/<명령>` 형식입니다. 대시보드를 다시 열거나 주소를 확인할 때도 `/wax:init`을 실행합니다(이전의 `/wax:dashboard`는 init에 합쳐졌습니다). Codex·Antigravity CLI는 설치기가 스킬 13개를 연결하므로, 이전에 설치한 프로젝트는 설치기를 다시 실행해 새 스킬(init·join)을 추가하고, 남아 있는 `.agents/skills/wax-dashboard` 링크는 지우세요. 자세한 내용은 매뉴얼 6절을 참고하세요.

## 업데이트 및 직접 개선

GitHub 마켓플레이스(`cafein-network/wax`)로 설치했다면 각 도구의 업데이트 명령 하나로 올라갑니다: Claude Code `claude plugin marketplace update wax` → `claude plugin update wax@wax`, Codex `codex plugin marketplace upgrade wax` → `codex plugin add wax@wax`, GitHub Copilot CLI `copilot plugin update wax@wax`, Gemini CLI `gemini extensions update wax`.

ZIP 폴더로 설치했다면 호스트 세션을 닫고 기존 폴더를 백업한 뒤 새 ZIP의 `wax` 폴더를 같은 경로에 놓고, 위 "한 번 설치" 절의 업데이트 방법을 따르세요. 작업 프로젝트의 `.wax`와 `docs/wax`는 그대로 둡니다. 프로젝트에 `.agents/skills`를 연결했다면 `install-codex.mjs --project <프로젝트> --check`로 연결을 확인합니다.

기록을 읽지 못하거나 저장 잠금 오류가 나면 `node "/path/to/wax/bin/wax.mjs" doctor --project "/path/to/project"`로 검사합니다. JSON의 `issues`에 문제가 있는 파일을 표시하고, 문제가 있으면 종료 코드 1을 반환합니다. 잠금이 있다고 종료된 작업이라고 단정하지 않으며 실행 중인 저장 작업을 먼저 확인해야 합니다.

소스와 테스트가 ZIP에 포함되어 있습니다. `src/workflow.mjs`에서 작업 상태 처리를, `scripts/build-commands.mjs`에서 코딩 도구에 전달할 지시를 개선할 수 있습니다.

```sh
npm run build
npm run check
npm test
```

ZIP을 다시 만들려면 Python 3.11 이상에서 `npm run package`를 실행합니다. Windows에서는 `py -3 scripts/package-release.py`도 사용할 수 있습니다. 결과는 `dist/`에 생성됩니다. 새 파일을 배포에 포함하려면 스크립트의 명시적 파일 목록을 갱신하세요.

Windows PowerShell에서 `npm run test:windows`로 Codex junction 설치·연결 실행·한글 경로·단계 전환·테스트 근거·백업을 확인할 수 있습니다. 플러그인 안의 임시 프로젝트에서 실행한 뒤 정리하며, Windows Node.js 22.17.0에서 통과했습니다.

## 비용과 검증 범위

wax 자체는 무료입니다(AGPL-3.0: 누구나 쓰고 고치고 배포할 수 있으며, 배포 시 소스 제공 조건을 따르며, 수정본을 네트워크로 제공하면 원격 사용자에게 대응 소스를 제공해야 합니다). 구독으로 로그인한 Claude Code는 호스트의 구독 한도·추가 사용 설정을 따릅니다. 웹 서비스는 Anthropic·Gemini·OpenAI API를 지원하며, 선택한 모델과 계정의 사용량 요금·한도가 적용됩니다. 이 ZIP에는 웹 서비스가 포함되지 않습니다.

자동 검사는 작업 기록·단계 전환·CLI와 압축 해제 후 실행을 검증합니다. 실제 AI가 처음부터 끝까지 코드를 수정하는 과정과 유료 API 호출은 이 릴리스에서 검증하지 않았습니다.

자세한 내용: [전체 사용 매뉴얼](docs/USER_GUIDE.md) · [English user guide](docs/USER_GUIDE.en.md).

