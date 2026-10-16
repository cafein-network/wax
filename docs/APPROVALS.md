# wax 실행 승인 관리

대시보드와 채널 화면의 **실행 승인** 카드는 연결된 AI 도구가 보낸 권한 요청을 보여 줍니다. 실행할 명령, 파일 변경, 작업 경로, 세션과 만료 시각을 확인한 뒤 **이번만 허용** 또는 **거부**를 선택합니다. 일반 메시지로 적은 “허용”이나 에이전트의 업무 배정은 권한 승인으로 처리하지 않습니다.

## 연결 방법

먼저 작업 프로젝트의 대시보드를 실행합니다.

```sh
node /path/to/wax/bin/wax.mjs --project /path/to/project dashboard
```

### Claude Code

GUI 승인을 사용할 세션에서 `WAX_APPROVALS=on`을 설정하고 이 버전의 wax 플러그인을 로드하세요. 기본값은 꺼짐이며 콘솔 승인 흐름을 유지합니다. PowerShell 예시는 다음과 같습니다.

```powershell
$env:WAX_APPROVALS = 'on'
claude
```

`PermissionRequest`와 `SessionEnd`는 표준 `hooks/hooks.json`에 등록하고, 사용량 모드는 `claude-mods/hooks.json`에서 별도로 로드합니다. 플러그인 변경 후 `/reload-plugins` 또는 새 세션에서 `/hooks`에 `PermissionRequest`가 보이는지 확인하세요. 요청의 작업 경로에서 가장 가까운 `.wax` 프로젝트를 찾고, 기본 포트 4330의 대시보드가 같은 프로젝트인지 확인합니다. 다른 포트라면 Claude Code를 시작할 환경에서 `WAX_APPROVAL_PORT`를 해당 값으로 지정하세요. 프로젝트를 명시하려면 `WAX_PROJECT`를 설정하며, 요청 작업 경로가 그 프로젝트 안에 있어야 합니다.

대시보드가 없거나 다른 프로젝트를 가리키면 기존 콘솔의 승인 흐름을 유지합니다. GUI 응답은 최대 30초 기다립니다. 훅은 대기 주소와 제한 시간을 stderr로 안내하며 표시 방식은 Claude 실행 환경을 따릅니다. 만료·연결 오류 때 허용 응답을 만들지 않습니다. `WAX_APPROVALS=off`로 시작하면 wax 승인 연결을 끕니다. 도구 사용 인수만 로컬 승인 기록에 저장하며 대화 전체나 transcript 파일은 읽지 않습니다.

`SessionEnd` 훅은 같은 세션의 남은 요청을 종료합니다. 일반 도구 승인 요청을 지원하며, Claude의 샌드박스 네트워크 질문처럼 `PermissionRequest` 훅이 발생하지 않는 요청은 콘솔에서 처리해야 합니다. 다른 훅과 호스트의 거부 정책은 계속 적용됩니다. [Claude 공식 승인 훅 규격](https://code.claude.com/docs/en/hooks#permissionrequest)

### Codex

wax가 연결한 App Server 세션으로 작업을 실행합니다. 이 명령은 설치된 Codex와 그 로그인·모델·권한 설정을 사용하며 실제 AI 작업을 시작합니다.

```sh
node /path/to/wax/bin/wax.mjs --project /path/to/project approvals codex --prompt "로그인 테스트를 실행하고 실패 원인을 확인해줘"
```

응답은 실행한 터미널에 표시하고 실행 승인은 GUI에서 처리합니다. 끝에 출력된 세션 ID를 사용해 다음 작업을 이어갑니다.

```sh
node /path/to/wax/bin/wax.mjs --project /path/to/project approvals codex --thread SESSION_ID --prompt "확인한 문제를 수정해줘"
```

실행 파일을 찾지 못하면 `--executable`로 `codex.exe`, `codex.js` 또는 실행 가능한 Codex 바이너리의 경로를 지정합니다. Windows의 npm 설치에서는 셸 문자열 대신 Node로 `codex.js`를 실행합니다.

명령 실행과 파일 변경의 승인 요청을 지원합니다. 파일 변경은 App Server가 보낸 변경 내용을 함께 표시하며, 변경 내용이 없으면 허용하지 않습니다. `grantRoot`가 포함된 세션 단위 디렉터리 쓰기 요청은 거부합니다. 네트워크 요청은 호스트·프로토콜 등 원래 요청 범위를 표시합니다. Codex가 한 요청으로 묶은 네트워크 작업은 함께 영향을 받을 수 있습니다. 세션 전체 허용이나 권한 규칙 추가는 제공하지 않습니다.

별도로 열려 있는 Codex TUI·IDE 세션에 접속하거나 권한 설정을 바꾸지는 않습니다. 사용자 질문, MCP 입력, 새로운 종류의 권한 요청 등 지원하지 않는 프로토콜 요청에는 허용을 반환하지 않으며 원래 인터페이스에서 진행하도록 알립니다. [공식 OpenAI App Server 규격](https://developers.openai.com/codex/app-server/)

Gemini CLI, Copilot CLI, Antigravity CLI의 실행 승인은 아직 연결하지 않았습니다. 이 도구의 승인 질문은 해당 콘솔에서 처리합니다.

## 상태와 재접속

| 표시 | 의미 |
| --- | --- |
| 승인 대기 | 사용자가 아직 선택하지 않음 |
| 응답 전달 대기 | 선택을 저장했으며 도구 연결이 가져가기를 기다림 |
| 응답 전달 중 | 도구 연결이 이번 응답을 한 번 가져감 |
| 도구 연결에 응답 전달됨 | 호스트 연결로 응답 쓰기를 마침. 실행 성공과는 별개 |
| 대기 만료 | 응답 가능한 시간이 지나 더 이상 승인할 수 없음 |
| 요청 종료 | 세션·요청·연결 종료로 더 이상 승인할 수 없음 |

새로고침해도 요청과 결정은 유지됩니다. 여러 탭에서 응답하면 먼저 저장한 결정 하나만 적용됩니다. 화면이 오래되었거나 네트워크 오류가 있으면 상태를 새로 확인한 뒤 선택하세요. 서버를 재시작하면 페이지가 새 토큰과 승인 상태를 다시 읽습니다. 연결이 확인되지 않는 동안 버튼은 비활성화됩니다.

Claude는 30초 동안 응답이 없으면 원래 권한 흐름으로 돌아갑니다. wax가 실행한 Codex 연결은 최대 120초 기다린 뒤 요청을 거부합니다. 사용자가 Ctrl+C로 Codex 작업을 중단하거나 호스트가 요청을 철회하면 대기 요청도 종료합니다. 자동 재승인하지 않습니다.

터미널에서 조회만 하려면 다음 명령을 사용합니다.

```sh
node /path/to/wax/bin/wax.mjs --project /path/to/project approvals list
```

## 저장과 권한 범위

승인 원문, 사용자 선택과 상태 이력은 `.wax/approvals/`에 남습니다. 대시보드는 시작할 때와 60초마다 완료 기록을 최근 100건으로 정리하며, 화면에는 그중 50건을 표시합니다. 진행 중 요청과 손상·외부 프로젝트 기록은 자동 삭제하지 않습니다. 만료 기록은 응답 전달과 충돌하지 않도록 5초 유예 후 정리 대상이 됩니다. 목록 조회 자체는 읽기 전용이며, 파일 메타데이터 서명이 바뀐 기록만 다시 읽고 검증합니다. 승인 결정은 캐시를 사용하지 않고 잠금 안에서 원문을 재검증합니다.

원문 인수에 민감한 값이 포함될 수 있으므로 이 폴더를 공개 저장소에 올리지 마세요. 현재 작업 백업에는 승인 기록을 포함하지 않습니다. 이력 복원으로 과거 승인을 재사용하지 않습니다.

GUI 응답은 기존 대시보드의 Host·Origin·세션 토큰 검사와 요청 내용 지문을 확인합니다. 어댑터는 요청별 비밀값으로 자기 응답만 한 번 가져갑니다. 읽기 API에는 비밀값이나 그 해시를 반환하지 않습니다. 승인과 실행은 구분하며 파일시스템 또는 관리자의 강제 거부를 wax가 해제하지 않습니다.

wax는 단일 사용자의 로컬 도구입니다. 같은 OS 계정으로 파일과 루프백 서버에 접근할 수 있는 프로세스 사이에 별도의 보안 경계를 제공하지 않습니다. 원격 사용자 인증·역할 관리가 있는 승인 서버로 공개하는 구성은 지원하지 않습니다.

## 검증

`node --test test/approvals.test.mjs test/approvals-ui.test.mjs test/approval-retention.test.mjs`는 요청별 승인, 중복·만료·취소, 원문 변조와 프로젝트 분리, HTTP 인증, 실제 훅 프로세스의 입출력, 모의 Codex App Server의 실행 흐름, 500건 캐시와 보존 한도를 검증합니다. UI 상태 검사는 응답 유실, 중복 클릭, 연결 끊김, 서버 토큰 갱신, 페이지 복원을 포함합니다. 자동 테스트는 유료 모델 호출을 사용하지 않습니다.

2026-10-16 검증에서는 실제 Claude Code 2.1.301의 `/hooks`에서 로컬 플러그인의 두 이벤트 등록을 확인했습니다. 설치된 Codex를 사용한 실행 검사는 실행 환경의 홈 디렉터리 인식 오류로 시작 전에 종료되어, 실제 모델의 승인 요청부터 실행까지는 아직 확인하지 못했습니다. 실제 브라우저 검사는 검증 환경에서 Chromium 하위 프로세스가 종료되어 완료하지 못했습니다.

기존 Puppeteer와 Chromium 계열 브라우저가 있는 환경에서는 `node scripts/verify-approvals-browser.mjs <puppeteer 모듈 경로> <브라우저 실행 파일>`로 GUI 버튼, 새로고침, 만료, 응답 전달 표시와 모바일 폭을 확인합니다. Puppeteer는 wax의 런타임 의존성이 아닙니다.

## 요청 대시보드의 도구 선택 (0.12.0)

새 요청의 실행 도구에서 Codex·Claude Code·Gemini CLI·GitHub Copilot CLI·Antigravity CLI 중 설치한 도구를 선택합니다. 해당 CLI의 로그인 또는 API 설정과 계정 사용량·비용·데이터 정책이 적용됩니다. 요청은 저장된 도구로 계속 진행하며 다른 도구를 쓰려면 새 요청을 만듭니다. Codex·Claude·Gemini·Copilot의 새 권한 요청은 화면에서 이번만 허용하거나 거부합니다. Antigravity는 기존에 허용된 범위로 실행하며, 새 권한 요청이 막히면 터미널의 설정을 확인해야 합니다.

연결 방식은 Codex App Server, Claude Code stream-json control protocol, Gemini CLI·Copilot CLI의 ACP, Antigravity CLI stream-json입니다. ACP 클라이언트는 파일·터미널 실행 기능을 제공하지 않으며 CLI 자체의 도구와 권한 설정을 사용합니다. 도구 버전이 프로토콜을 지원하지 않으면 연결 오류를 표시하며 다른 계정으로 전환하지 않습니다.

- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)
- [Copilot ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- [ACP 승인](https://agentclientprotocol.com/protocol/v1/tool-calls)
- [Antigravity headless](https://www.antigravity.google/docs/cli/headless/)
