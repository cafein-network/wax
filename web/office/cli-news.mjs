export const CLI_NEWS = {
  asOf: '2026-10-16',
  tools: {
    claude: {
      latest: '2.1.301', update: 'claude update', source: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md',
      items: [
        { version: '2.1.301', text: '모드 입력창이 여러 줄을 지원하고, vim의 % 키로 짝이 맞는 괄호를 오갈 수 있어요' },
        { version: '2.1.301', text: '훅으로 만든 worktree의 미전송 커밋 보호와 검색 실패 표시를 개선했어요' },
      ],
    },
    codex: {
      latest: '0.163.0', update: 'npm install -g @openai/codex@latest', source: 'https://github.com/openai/codex/releases',
      items: [
        { version: '0.163.0', text: '/config에서 설정을 검색·변경하고, 응답 도중 후속 메시지로 진행 방향을 바꿀 수 있어요' },
        { version: '0.163.0', text: '/keymap에서 리더 키를 정하고, /daemon에서 관리 중인 서버를 재시작할 수 있어요' },
      ],
    },
    copilot: {
      latest: '1.0.98', update: 'copilot update', source: 'https://github.com/github/copilot-cli/releases',
      items: [
        { version: '1.0.98', text: 'Gemini 4 Argon 지원과 세션 전환 뒤 MCP 상태 동기화가 추가됐어요' },
        { version: '1.0.98', text: '/ask 답변을 펼치거나 전체 복사할 수 있고, 중단했던 권한 요청 복원을 개선했어요' },
      ],
    },
    gemini: {
      latest: '0.64.0', update: 'npm install -g @google/gemini-cli@latest', source: 'https://github.com/google-gemini/gemini-cli/releases',
      items: [
        { version: '0.64.0', text: '파일 쓰기와 상태 저장이 원자적으로 처리되고, 손상되면 백업에서 복구해요' },
        { version: '0.64.0', text: 'ACP 브리지가 사용량을 보고하고, a2a-server 설정이 V2로 옮겨졌어요' },
      ],
    },
    antigravity: {
      latest: '1.3.6', update: 'agy update', source: 'https://antigravity.google/docs/changelog/',
      items: [
        { version: '1.3.6', text: 'ADC 인증에서 Claude 5.5 모델을 지원하고, /diff 커밋 트리에 색상을 입혔어요' },
        { version: '1.3.6', text: '모델 연결이 멈추면 자동으로 취소·재시도하고, 자동 모드의 검토를 개선했어요' },
      ],
    },
  },
};

export function newerThan(a, b) {
  const parts = (v) => String(v ?? '').split(/[.+-]/).map((n) => Number.parseInt(n, 10));
  const x = parts(a), y = parts(b);
  if (x.some(Number.isNaN) || y.slice(0, 2).some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}
