import { t } from '../messages-catalog.mjs';
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
const prop = svg(t('office.studioDemo.rectWidth360Height'));
const at = (minutes) => new Date(Date.UTC(2026, 9, 17, 3, minutes)).toISOString();

export const DEMO_DESIGN = {
  demo: true,
  targets: [
    { id: 'target-demo0001', tool: 'figma', label: t('office.studioDemo.lookbookUploadScreen'), figma: { fileKey: 'DemoFileKey000', nodeId: '12:34', url: 'https://www.figma.com/design/DemoFileKey000/?node-id=12-34' },
      checks: { codex: { agent: 'codex', state: 'read-write', detail: t('office.studioDemo.targetFrameReadWrite'), checkedAt: at(0) },
        claude: { agent: 'claude', state: 'unsupported', detail: t('office.studioDemo.waxCannotFetchFigma'), next: t('office.studioDemo.chooseCodexAsThe'), checkedAt: at(0) } } },
    { id: 'target-demo0002', tool: 'blender', label: t('office.studioDemo.uploadStandProp'), blender: { file: 'design/blender/upload-stand.blend', scene: 'Scene', collection: 'WAX_UploadStand' },
      checks: { codex: { agent: 'codex', state: 'target-mismatch', detail: t('office.studioDemo.aDifferentFileTrebuchet'), next: t('office.studioDemo.inBlenderOpenThe'), checkedAt: at(1) } } },
  ],
  jobs: [
    { id: 'design-00000000-0000-4000-8000-000000000001', targetId: 'target-demo0001', tool: 'figma', agent: 'codex', title: t('office.studioDemo.lookbookUploadScreen'), brief: t('office.studioDemo.firstScreenForUploading'), feature: 'lookbook-upload',
      status: 'review', detail: t('office.studioDemo.v2IsFinishedCheck'), revision: 5,
      versions: [
        { n: 1, at: at(10), source: { fileKey: 'DemoFileKey000', nodeId: '12:99' }, previewUrl: frame(false, false), changes: t('office.studioDemo.placedTheUploadArea') },
        { n: 2, at: at(24), source: { fileKey: 'DemoFileKey000', nodeId: '12:99' }, previewUrl: frame(true, true), changes: t('office.studioDemo.madeTheButtonFull'), feedback: 'demo-feedback-1' },
      ],
      feedback: [{ id: 'demo-feedback-1', version: 1, text: t('office.studioDemo.makeTheUploadButton'), author: t('office.studioDemo.ceo'), at: at(15) }],
      approved: null, handoff: null, createdAt: at(5), updatedAt: at(24) },
  ],
};
