export const PROJECT_TYPES = {
  general: { label: '일반 프로젝트', brief: '목표와 저장소에 맞는 실행 환경·작은 기능·검증 방법을 먼저 정합니다.' },
  roblox: { label: 'Roblox 게임', brief: 'Studio 반영 방법과 작은 플레이 루프부터 정하고, 실제 플레이·조작·화면을 검증합니다.' },
  lookbook: { label: 'AI 룩북', brief: '상품 선택 → 이미지 생성 → 저장·편집 → 상품 연결을 한 장부터 검증합니다.' },
  web: { label: '웹 서비스', brief: '실행 명령과 주소를 먼저 정하고, 화면 시안·E2E 테스트·화면 캡처로 실제 동작을 검증합니다.' },
};
export function projectType(value = 'auto', text = '', repoHint = null) {
  if (value !== 'auto') {
    if (!Object.hasOwn(PROJECT_TYPES, value)) throw new Error('프로젝트 종류는 auto, general, web, roblox, lookbook 중 선택하세요.');
    return value;
  }
  if (/roblox|로블록스|로블룩스|로블록|\bluau\b|\brojo\b/i.test(text)) return 'roblox';
  if (/룩북|lookbook|\bfashn\b/i.test(text)) return 'lookbook';
  if (/웹 ?서비스|웹 ?앱|웹사이트|홈페이지|랜딩 ?페이지|프론트엔드|\bweb ?app|\bwebsite|\blanding page|\bfrontend|\bnext\.?js|\breact\b|\bvue\b|\bsvelte|\bnuxt|\bvite\b|\bplaywright/i.test(text)) return 'web';
  return repoHint && repoHint !== 'auto' && Object.hasOwn(PROJECT_TYPES, repoHint) ? repoHint : 'general';
}
const preview = (label) => ({ id: 'design-preview', label, kind: 'preview' });
const check = (id, label, kind) => ({ id, label, kind });
export function qualityRequirements(type, phase, mode = 'project') {
  if (mode === 'sm' && phase === 'design') return [];
  if (type === 'roblox') return ({
    design: [preview('맵 동선·조작·보상의 시안 또는 블록아웃')],
    implement: [check('play-loop', 'Studio에서 작은 게임 루프 실행', 'runtime')],
    review: [check('play-loop', '입장부터 보상·재시작까지 플레이 검증', 'runtime'), ...(mode === 'sm' ? [] : [check('game-presentation', '조작·카메라·충돌·화면 검토', 'visual')])],
  })[phase] || [];
  if (type === 'lookbook') return ({
    design: [preview('업로드·대기·실패·편집 화면 시안')],
    implement: [check('generation-storage', '실제 이미지 생성부터 자체 저장까지 연동', 'integration')],
    review: [check('generation-storage', '실제 생성·저장·재접속 검증', 'integration'), ...(mode === 'sm' ? [] : [check('product-fidelity', '원본 상품 표현과 생성 컷 비교', 'visual')]), check('product-links', '룩북 편집·상품 연결·모바일 흐름 검증', 'runtime')],
  })[phase] || [];
  if (type === 'web') return ({
    design: [preview('주요 화면 시안 캡처(모바일·데스크톱)')],
    implement: [check('e2e-smoke', '핵심 사용자 흐름 Playwright 테스트', 'runtime')],
    review: [check('e2e-acceptance', '수용 기준 시나리오 Playwright 테스트', 'runtime'), ...(mode === 'sm' ? [] : [check('ui-review', '로딩·오류·빈 상태와 모바일 화면 검토', 'visual')])],
  })[phase] || [];
  return [];
}
export const PHASE_ROOMS = { plan: { id: 'meeting', label: '1F 회의실' }, design: { id: 'studio', label: 'B1 디자인실' }, implement: { id: 'dev', label: '2F 개발실' }, review: { id: 'lab', label: '3F 연구소' }, report: { id: 'boss', label: '4F 사장실' }, done: { id: 'boss', label: '4F 결과 보고' } };
