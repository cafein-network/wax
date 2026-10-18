const svg = (body) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 640" font-family="sans-serif">${body}</svg>`)}`;
const frame = (button, banner) => svg(`<rect width="360" height="640" fill="#f6f4f1"/>
<text x="24" y="52" font-size="20" font-weight="700" fill="#222">룩북 만들기</text>
<text x="24" y="78" font-size="12" fill="#666">상품 사진을 올리면 착용 컷을 만들어요</text>
${banner ? '<rect x="24" y="96" width="312" height="44" rx="8" fill="#fde8e4"/><text x="40" y="123" font-size="12" fill="#b3261e">사진이 흐리면 다시 올려 주세요 · JPG/PNG 20MB 이하</text>' : ''}
<rect x="24" y="${banner ? 156 : 104}" width="312" height="280" rx="16" fill="#fff" stroke="#c9c2b8" stroke-dasharray="8 6" stroke-width="2"/>
<circle cx="180" cy="${banner ? 266 : 214}" r="30" fill="#e8e1d7"/><text x="180" y="${banner ? 272 : 220}" text-anchor="middle" font-size="26" fill="#8a7f72">+</text>
<text x="180" y="${banner ? 326 : 274}" text-anchor="middle" font-size="13" fill="#555">상품 사진을 끌어 놓거나 선택</text>
<rect x="${button ? 24 : 108}" y="${banner ? 460 : 410}" width="${button ? 312 : 144}" height="${button ? 56 : 40}" rx="12" fill="#2f6f5e"/>
<text x="180" y="${banner ? 494 : 435}" text-anchor="middle" font-size="${button ? 17 : 13}" font-weight="700" fill="#fff">사진 올리기</text>
<text x="24" y="${banner ? 560 : 500}" font-size="11" fill="#888">데모 예시 화면 · 실제 Figma 결과 아님</text>`);
const prop = svg(`<rect width="360" height="640" fill="#1f2328"/><ellipse cx="180" cy="470" rx="110" ry="22" fill="#111"/>
<rect x="150" y="250" width="60" height="210" rx="6" fill="#9aa4ad"/><rect x="90" y="220" width="180" height="40" rx="10" fill="#c7cdd2"/>
<text x="180" y="580" text-anchor="middle" font-size="12" fill="#aaa">데모 예시 렌더 · 실제 Blender 결과 아님</text>`);
const at = (minutes) => new Date(Date.UTC(2026, 9, 17, 3, minutes)).toISOString();

export const DEMO_DESIGN = {
  demo: true,
  targets: [
    { id: 'target-demo0001', tool: 'figma', label: '룩북 업로드 화면', figma: { fileKey: 'DemoFileKey000', nodeId: '12:34', url: 'https://www.figma.com/design/DemoFileKey000/?node-id=12-34' },
      checks: { codex: { agent: 'codex', state: 'read-write', detail: '대상 프레임 읽기 확인 · 쓰기 도구(use_figma) 사용 가능. 파일 편집 권한과 플랜은 첫 제작에서 확인됩니다.', checkedAt: at(0) },
        claude: { agent: 'claude', state: 'unsupported', detail: 'Claude Code 세션의 Figma 화면을 wax가 직접 받아 올 방법이 없어 미리보기를 확인할 수 없습니다.', next: 'Figma 작업은 실행 도구를 Codex로 선택하세요.', checkedAt: at(0) } } },
    { id: 'target-demo0002', tool: 'blender', label: '업로드 받침대 소품', blender: { file: 'design/blender/upload-stand.blend', scene: 'Scene', collection: 'WAX_UploadStand' },
      checks: { codex: { agent: 'codex', state: 'target-mismatch', detail: 'Blender에 다른 파일(trebuchet.blend)이 열려 있습니다. wax는 다른 파일을 수정하지 않습니다.', next: 'Blender에서 프로젝트의 design/blender/upload-stand.blend을(를) 열거나 새 파일을 그 경로로 저장한 뒤 다시 검사하세요.', checkedAt: at(1) } } },
  ],
  jobs: [
    { id: 'design-00000000-0000-4000-8000-000000000001', targetId: 'target-demo0001', tool: 'figma', agent: 'codex', title: '룩북 업로드 화면', brief: '상품 사진을 올리는 첫 화면. 모바일 기준, 실패 안내 포함.', feature: 'lookbook-upload',
      status: 'review', detail: 'v2 제작을 마쳤습니다. 미리보기를 확인하고 수정 의견을 보내거나 확정하세요.', revision: 5,
      versions: [
        { n: 1, at: at(10), source: { fileKey: 'DemoFileKey000', nodeId: '12:99' }, previewUrl: frame(false, false), changes: '업로드 영역과 버튼을 배치했습니다.' },
        { n: 2, at: at(24), source: { fileKey: 'DemoFileKey000', nodeId: '12:99' }, previewUrl: frame(true, true), changes: '버튼을 화면 폭으로 키우고 실패 안내를 위로 올렸습니다.', feedback: 'demo-feedback-1' },
      ],
      feedback: [{ id: 'demo-feedback-1', version: 1, text: '업로드 버튼을 더 크게, 실패 안내는 위로 올려 주세요.', author: '대표', at: at(15) }],
      approved: null, handoff: null, createdAt: at(5), updatedAt: at(24) },
  ],
};
