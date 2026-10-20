# wax 0.13.4 — 2026-10-20

- **웹 서비스** 프로젝트 종류를 추가했습니다. 요청 문장이나 저장소 `package.json`의 웹 프레임워크·`@playwright/test`로 자동 선택되며, 설계 화면 캡처·구현 `e2e-smoke`·검토 `e2e-acceptance`와 `ui-review`를 단계 완료 조건으로 요구합니다. 기존 작업의 종류는 바뀌지 않습니다.
- `wax capture`가 캡처 명령을 셸 없이 실행하고 결과 이미지를 `.wax/artifacts/<작업>/<단계>-<주기>/`에 보관해 검증 항목에 연결할 경로를 돌려줍니다. 캡처는 근거가 아닌 산출물입니다.
- 웹 작업의 자동 진행 안내·CLI prompt·다섯 도구용 스킬에 `playwright-cli`(탐색·재현·캡처)와 `@playwright/test`(근거) 사용 순서를 넣었습니다.
- `wax doctor`가 `playwright-cli`·`@playwright/test` 설치 여부와 설치 명령을 `browser` 항목에 보여 줍니다. 진단 결과에는 영향을 주지 않습니다.
- wax는 명령을 셸 없이 실행하므로 근거 명령은 Windows에서도 동작하는 `node node_modules/@playwright/test/cli.js test`로 안내합니다. Windows에서 `playwright-cli`는 먼저 캡처한 뒤 `wax capture --file`로 등록합니다.
- 웹 서비스 작업은 0.13.3 이하 버전이 읽지 못합니다. 같은 프로젝트를 여러 도구로 쓰면 모든 도구의 wax를 함께 업데이트하세요.
