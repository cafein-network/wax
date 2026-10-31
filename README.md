# wax

[![Public checks](https://github.com/cafein-network/wax/actions/workflows/public.yml/badge.svg)](https://github.com/cafein-network/wax/actions/workflows/public.yml)

**AI 코딩 도구를 바꿔도 작업은 이어집니다.** wax는 Claude Code, Codex, Antigravity CLI, GitHub Copilot CLI, Grok Build, Gemini CLI에 **기획 → 설계 → 구현 → 검토 → 보고** 흐름을 더하는 플러그인입니다. 단계 문서, 완료 근거(실제 실행한 테스트·연결한 Git 커밋), 개선 이력을 프로젝트 안의 `.wax/`에 남겨, 어느 도구의 세션이든 같은 기록을 이어받습니다.

> wax adds a plan → design → implement → review → report workflow to Claude Code, Codex, Antigravity CLI, GitHub Copilot CLI, Grok Build and Gemini CLI. Phase documents and real evidence (tests actually run, linked commits) are stored in the project's `.wax/`, so any tool can pick up where another left off. Documentation is in Korean.

- 홈페이지: https://wax.me2shop.com
- 배포 ZIP과 출처 증명: [GitHub Releases](https://github.com/cafein-network/wax/releases/latest). Ubuntu·macOS·Windows와 Node 22·24에서 검사를 통과한 버전만 올라갑니다.
- 이 저장소는 **AGPLv3 배포본만** 담습니다. **0.12.0을 초기 릴리스**로 시작하며, 이후 릴리스마다 갱신됩니다.

## 요청과 보고

새 요청의 실행 도구에서 Codex·Claude Code·Gemini CLI·GitHub Copilot CLI·Antigravity CLI 중 설치한 도구를 선택합니다. Grok Build는 아직 자동 진행을 지원하지 않으므로 터미널 세션에서 스킬 이름을 밝혀 요청하는 팀 작업으로 씁니다. 해당 CLI의 로그인 또는 API 설정과 계정 사용량·비용·데이터 정책이 적용됩니다. 요청은 저장된 도구로 계속 진행하며 다른 도구를 쓰려면 새 요청을 만듭니다. Codex·Claude·Gemini·Copilot의 새 권한 요청은 화면에서 이번만 허용하거나 거부합니다. Antigravity는 기존에 허용된 범위로 실행하며, 새 권한 요청이 막히면 터미널의 설정을 확인해야 합니다.

공식 CLI 프로토콜의 모의 실행으로 승인·거부·중지·이어가기와 보고 처리를 검증했습니다. 각 제공자의 실제 계정을 이용한 전체 자동 작업은 별도로 확인해야 합니다. 화면을 열기만 해서는 AI를 실행하지 않습니다.

## 설치 (한 번만)

Node.js 22 이상이 필요합니다. 쓰는 도구만 골라 두 줄씩 실행하면, 이후 모든 프로젝트에서 wax를 씁니다.

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

# Gemini CLI (기존 사용자, 개인 사용자는 Antigravity CLI 권장)
gemini extensions install https://github.com/cafein-network/wax
```

**Antigravity CLI**와 **Grok Build**는 프로젝트에 스킬을 연결해 씁니다. 이 저장소를 내려받은 뒤 프로젝트마다 한 번 연결하세요. 연결기는 `.agents/skills`(Codex·Antigravity CLI·GitHub Copilot CLI)와 `.grok/skills`(Grok Build)에 같은 스킬을 연결합니다.

```sh
git clone https://github.com/cafein-network/wax
node wax/scripts/install-project.mjs --project "/path/to/your-project"
```

인터넷 연결 없이 설치하려면 [홈페이지](https://wax.me2shop.com/#download)의 ZIP을 받아, 압축을 푼 폴더 경로를 `cafein-network/wax` 자리에 넣으면 됩니다(예: `claude plugin marketplace add "/path/to/wax"`). 자세한 내용은 [설치 안내](./INSTALL.md)를 보세요.

### 업데이트와 제거

0.14.0부터 공개 저장소를 새 이력으로 다시 만들었습니다. 예전에 등록한 마켓플레이스의 업데이트가 실패하면 등록을 지우고 다시 등록하세요([INSTALL.md](INSTALL.md)).

| 도구 | 업데이트 | 제거 |
| --- | --- | --- |
| Claude Code | `claude plugin marketplace update wax` → `claude plugin update wax@wax` | `claude plugin uninstall wax@wax` |
| Codex | `codex plugin marketplace upgrade wax` → `codex plugin add wax@wax` | `codex plugin remove wax@wax` |
| GitHub Copilot CLI | `copilot plugin update wax@wax` | `copilot plugin uninstall wax@wax` |
| Gemini CLI | `gemini extensions update wax` | `gemini extensions uninstall wax` |
| Antigravity CLI, Grok Build | 연결한 wax 폴더를 갱신(`git pull` 또는 새 ZIP) | 프로젝트의 `.agents/skills/wax-*`, `.grok/skills/wax-*` 링크 삭제 |

## 사용법

가장 간단한 시작은 `init`입니다. 기본값으로 바로 참여하고 대시보드를 엽니다. 대시보드 첫 화면은 팀 채널이며, **＋ 새 요청**으로 여는 요청과 보고 화면(`/start`)에서 **프로젝트** 또는 **SM · 유지보수**를 고르고 **무엇을 할까요?**에 목표를 입력합니다. 프로젝트는 워크플로우를 먼저 만들어 확인한 뒤 실행하고, SM은 유지보수 요청을 분석부터 수정·검증·처리 보고까지 바로 진행합니다. 질문에는 같은 채팅에서 답하고 방향도 대화로 바꿀 수 있습니다. 중지·이어서 진행 버튼으로 실행을 제어합니다.

**프로젝트 모드**는 범위·작업 순서·산출물·완료 기준을 먼저 정리합니다. 내용을 확인하고 **이 워크플로우로 시작**을 누르면 설계·구현·검토·보고로 이어집니다. 수정할 점을 보내면 워크플로우를 다시 작성합니다. **SM 모드**는 기존 서비스의 오류·개선 요청을 접수·분석 → 영향 확인 → 수정 → 회귀 검증 → 처리 보고로 처리합니다. 모드는 요청마다 저장되며 기존 요청은 SM으로 이어집니다.

요청과 보고 화면(`/start`)의 **시작 가이드**에서 설치된 실행 도구를 고르고 할 일을 입력하세요. 자동 진행은 선택한 CLI의 로그인 또는 API 설정을 사용해 별도 작업 세션을 시작합니다. PM 지정은 필요 없습니다. 계정의 사용량과 기존 권한 설정을 따릅니다. 화면만 보거나 팀 채널에 일반 메시지를 보내면 AI가 실행되지 않습니다. 기존 Claude·Codex 등의 터미널 세션과 프로젝트 PM은 그대로 유지합니다. 수동 배정과 자세한 기록은 **상세 기록**(`/manage`)에서 확인합니다.

참여한 AI가 대기 중이면 요청과 보고 화면의 **기존 AI 세션으로 팀 작업하기**를 펼치세요. PM 유무, 배정 상태와 세션별 실행 명령을 보여 줍니다. PM 세션에 `pm <목표>`를 요청하면 현재 참여자를 확인해 작업을 만들고 첫 단계를 바로 배정합니다. 목표가 주어졌으면 통상적인 범위·담당 선택을 계속 되묻지 않습니다. 담당 세션에서는 표시된 `work <업무ID>`를 실행합니다. 팀 채널에 메시지만 보내면 업무가 배정되지는 않습니다.

같은 명령을 도구마다 그 도구의 방식으로 부릅니다.

Codex CLI의 스킬 호출은 `$wax:work <업무ID>`처럼 `$`로 시작합니다. Codex 입력창의 `@`는 파일 첨부이며, wax 채널의 `@이름`은 받는 사람 알림입니다.

| 도구 | 예시 |
| --- | --- |
| Claude Code, Gemini CLI | `/wax:plan login 이메일 로그인 구현` |
| Codex | `$wax:plan login 이메일 로그인 구현` |
| Antigravity CLI | `/plan login 이메일 로그인 구현` |
| GitHub Copilot CLI, Grok Build | "wax plan 스킬로 login 이메일 로그인 기획해줘" (자체 `/status`·`/plan` 등과 겹치지 않게 스킬 이름을 밝혀 요청) |

| 명령 | 하는 일 |
| --- | --- |
| `init` | 기본값으로 바로 참여하고 요청·보고 화면을 엽니다. PM이 없으면 init한 세션이 PM이 됩니다(`--no-pm`으로 생략). 이름·작업 옵션은 지정한 경우에만 변경합니다. |
| `join` | 다른 AI 세션이 대기 상태로 참여합니다. 작업 실행은 별도이며, 같은 이름이 활동 중이면 `-2`처럼 번호를 붙입니다. |
| `plan` · `design` · `implement` · `review` · `report` | 해당 단계를 수행하고 문서와 완료 근거를 남깁니다. 요구사항이나 검증이 부족하면 단계를 완료하지 않습니다. |
| `status` | 현재 단계, 완료 근거, 남은 일, 다음 명령을 보여 줍니다. |
| `iterate` | 개선 사유를 남기고 구현 단계부터 다시 시작합니다. 이전 기록은 보관합니다. |
| `chat` · `pm` · `work` · `daily` | 여러 도구의 세션이 한 팀처럼 일하도록 채널 대화, PM 업무 배정, 일일 보고를 제공합니다. 로컬 대시보드는 `init`이 열어 줍니다. |

한 명령은 한 단계를 실행합니다. 실제 코드 수정과 테스트는 각 도구의 권한 확인을 거칩니다.

## 팀 대시보드

```sh
node /path/to/wax/bin/wax.mjs --project /path/to/your-project dashboard   # http://127.0.0.1:4330/
```

어느 도구의 세션이든 한 화면에서 같은 방식으로 봅니다. 팀 패널은 세션마다 **그 도구의 문법으로 다음 명령**(예: Codex `$wax:work t-1`, GitHub Copilot CLI "wax plan 스킬로 login 진행해줘")을 복사 버튼과 함께 보여 주고, 업무를 배정하면 그 세션에서 실행할 명령을 미리 보여 줍니다. 도움말에는 모든 명령의 도구별 부르는 방법이 한 표로 정리되어 있습니다. 세션이 밝힌 모델(예: Codex · gpt-5-codex)도 함께 표시합니다. 그 밖에 타임라인, PM 업무 배정, 일일 보고와 도트 가상 사무실을 보여 줍니다. 캐릭터를 누르면 프로젝트 기록으로 계산한 인사기록 카드(능력치·배지)가 나옵니다. 대시보드는 `127.0.0.1`에서 열리며, 요청과 보고 화면에서 사용자가 보낸 요청만 선택한 CLI로 실행합니다. Claude Code 세션은 `/wax:chat --watch`로 `@이름` 메시지가 올 때만 깨어나 답할 수 있습니다.

## 데이터와 보안

대시보드와 채널의 **실행 승인** 카드에서 요청 내용과 경로를 확인하고 **이번만 허용 / 거부**를 선택할 수 있습니다. Claude Code는 `WAX_APPROVALS=on`으로 시작한 세션에서 같은 프로젝트의 대시보드에 연결하며, 최대 30초 기다린 뒤 콘솔 승인으로 돌아갑니다. Codex는 `node bin/wax.mjs --project /path/to/project approvals codex --prompt "요청"`으로 시작한 App Server 세션에서 연결됩니다. 독립 실행 중인 Codex 콘솔은 자동으로 연결되지 않습니다. 연결 방법과 지원 범위는 [승인 관리 안내](./docs/APPROVALS.md)를 참고하세요.

- **기록은 로컬에 저장됩니다.** 작업은 `.wax/features/`, 팀 대화와 자동 진행 요청은 `.wax/chat/`, 단계 문서는 `docs/wax/`에 남습니다. 자동 진행을 보내면 선택한 도구가 요청과 작업 문맥을 해당 계정의 모델 서비스로 전달합니다. wax 자체 사용 통계는 수집하지 않습니다.
- **AI 호출은 각 도구가 합니다.** wax 자체는 AI API를 부르지 않으며, 각 도구의 로그인·이용 조건과 요금이 그대로 적용됩니다.
- **대시보드**는 `127.0.0.1`에만 열리고, 쓰기 요청은 페이지를 열 때 발급되는 토큰으로 확인합니다.
- **명령 실행**: 테스트 근거를 남길 때는 사용자가 지정한 명령만, 셸을 거치지 않고 실행합니다.
- `.wax/`와 `docs/wax/`에는 작업 내용이 들어가므로, 저장소에 올릴지는 프로젝트에 맞게 정하세요. API 키나 비밀번호를 단계 문서·메시지에 적지 마세요.

보안 문제는 [SECURITY.md](./SECURITY.md)의 방법으로 알려 주세요.

## 직접 실행 (CLI)

```sh
node bin/wax.mjs start login --title "이메일 로그인"
node bin/wax.mjs status login
node bin/wax.mjs context login --budget 3000
node bin/wax.mjs prompt plan login
node bin/wax.mjs save plan login --file docs/wax/login/plan.md
node bin/wax.mjs complete plan login --evidence "수용 기준 4개와 검증 방법 작성"
node bin/wax.mjs test login -- node --test   # 구현·검토는 통과한 테스트나 커밋 근거를 연결합니다
node bin/wax.mjs complete implement login --evidence "로그인 테스트 통과" --proofs <근거 ID>
node bin/wax.mjs doctor
```

`--project /path/to/your-project`로 대상 디렉터리를 지정합니다. 외부 런타임 의존성이 없어 `npm install` 없이 동작합니다. 도움말(`--help`)·안내·오류는 `WAX_LANG=en`이면 영어로 나옵니다. `WAX_LANG`이 없으면 `LC_ALL`·`LC_MESSAGES`·`LANG`이 `en`으로 시작할 때 영어이고, 기본은 한국어입니다. `--json` 출력과 AI 세션에 주는 지시문은 언어와 상관없이 같습니다. 전체 사용법은 [사용 매뉴얼](./docs/USER_GUIDE.md)([English](./docs/USER_GUIDE.en.md))에 있습니다.

`context`는 현재 작업의 목표·상태·다음 행동, 화이트보드 결정·미답변 질문, 테스트·커밋 근거, 개선 사유와 문서 발췌를 원본 참조와 함께 보여 줍니다. 기본 분량은 3,000자이며 `--budget`은 토큰이 아닌 유니코드 문자 수(1,000~100,000)입니다. 표시/전체 개수로 생략을 확인하고 필요한 원문을 읽으세요. 단계 스킬과 `work`는 작업 전에 이 문맥을 읽습니다. 조회는 파일을 수정하거나 AI를 호출하지 않으며, 테스트 결과는 실행 당시 코드 상태의 기록입니다.

## 개발과 검증

```sh
npm run check   # 명령·스킬 파일이 최신인지 확인
npm test        # node --test
npm run test:browser   # 대시보드·사무실·디자인실·검색·스레드·실행 승인을 실제 브라우저로 확인
```

`test:browser`는 런타임 의존성이 아닌 Playwright와 puppeteer-core를 씁니다. 설치한 모듈과 브라우저를 `WAX_PLAYWRIGHT_MODULE`(playwright의 `index.mjs`), `WAX_PUPPETEER_MODULE`(puppeteer-core의 `lib/esm/puppeteer/puppeteer-core.js`), `WAX_CHROMIUM_EXECUTABLE`로 지정합니다. 샘플 기록만 쓰고 AI를 호출하지 않습니다. CI는 PR과 수동 실행 때 Chromium으로 이 검사를 실행합니다.

공개 배포는 버전 태그(`vX.Y.Z`)로 실행합니다. 태그를 직접 만들 수 없는 배포 환경에서는 검토한 릴리스 변경을 `main`에 합칠 때 커밋 메시지에 `[publish-release]`를 명시할 수 있습니다. CI는 모든 운영체제 검사와 실제 Codex 설치 검사가 통과한 뒤 현재 버전의 태그를 만들고 ZIP·체크섬·출처 증명을 게시합니다. 일반 커밋은 검사만 실행하며, 이미 다른 커밋을 가리키는 같은 버전의 태그는 덮어쓰지 않습니다.

## 참고 규격

- [Claude Code 플러그인](https://code.claude.com/docs/en/plugins-reference)
- [Codex 스킬](https://learn.chatgpt.com/docs/build-skills)
- [Gemini CLI 확장](https://geminicli.com/docs/extensions/reference/)
- [Antigravity 스킬](https://antigravity.google/docs/skills)
- [GitHub Copilot CLI 플러그인](https://docs.github.com/copilot/concepts/agents/copilot-cli/about-cli-plugins)
- [Grok Build 스킬·플러그인](https://docs.x.ai/build/features/skills-plugins-marketplaces)

## 라이선스

Copyright (C) 2026 cafein-network

wax는 [GNU Affero General Public License v3.0](./LICENSE)(AGPL-3.0-only)으로 배포하는 자유 소프트웨어입니다. 누구나 무료로 쓰고, 고치고, 다시 배포할 수 있습니다. wax나 수정본을 배포할 때는 AGPLv3의 소스 제공 조건을 따라야 합니다. 수정한 버전을 네트워크로 제공하면 원격 사용자가 그 버전의 대응 소스를 받을 수 있도록 제공해야 합니다(제13조). 이 프로그램은 어떠한 보증도 없이 제공됩니다(자세한 내용은 LICENSE).

개발 cafein-network

리나의 도구 소식은 공식 공개 릴리스를 1시간 간격으로 확인합니다. 확인 시각과 출처를 표시하고, 실패 시 마지막 자료를 유지합니다. 설치 버전은 별도로 10분마다 읽습니다. 두 조회는 리나 카드의 버튼으로 즉시 다시 실행할 수 있습니다. 외부 조회 없이 쓰려면 `WAX_TOOL_NEWS=off`로 대시보드를 실행하세요.
