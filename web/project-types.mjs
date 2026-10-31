import { t } from './messages-catalog.mjs';
export const PROJECT_TYPES = {
  general: { label: t('projectTypes.generalProject'), brief: t('projectTypes.firstDecideTheRuntime') },
  roblox: { label: t('projectTypes.robloxGame'), brief: t('projectTypes.firstDecideHowTo') },
  lookbook: { label: t('projectTypes.aiLookbook'), brief: t('projectTypes.verifyProductSelectionImage') },
  web: { label: t('projectTypes.webService'), brief: t('projectTypes.settleTheRunCommand') },
};
export function projectType(value = 'auto', text = '', repoHint = null) {
  if (value !== 'auto') {
    if (!Object.hasOwn(PROJECT_TYPES, value)) throw new Error(t('projectTypes.chooseAProjectType'));
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
    design: [preview(t('projectTypes.mockupOrBlockoutOf'))],
    implement: [check('play-loop', t('projectTypes.runASmallGame'), 'runtime')],
    review: [check('play-loop', t('projectTypes.playTestFromEntry'), 'runtime'), ...(mode === 'sm' ? [] : [check('game-presentation', t('projectTypes.reviewControlsCameraCollision'), 'visual')])],
  })[phase] || [];
  if (type === 'lookbook') return ({
    design: [preview(t('projectTypes.mockupsOfTheUpload'))],
    implement: [check('generation-storage', t('projectTypes.integrateFromRealImage'), 'integration')],
    review: [check('generation-storage', t('projectTypes.verifyRealGenerationSaving'), 'integration'), ...(mode === 'sm' ? [] : [check('product-fidelity', t('projectTypes.compareTheOriginalProduct'), 'visual')]), check('product-links', t('projectTypes.verifyLookbookEditingProduct'), 'runtime')],
  })[phase] || [];
  if (type === 'web') return ({
    design: [preview(t('projectTypes.capturesOfTheMain'))],
    implement: [check('e2e-smoke', t('projectTypes.playwrightTestOfThe'), 'runtime')],
    review: [check('e2e-acceptance', t('projectTypes.playwrightTestsOfThe'), 'runtime'), ...(mode === 'sm' ? [] : [check('ui-review', t('projectTypes.reviewOfLoadingError'), 'visual')])],
  })[phase] || [];
  return [];
}
export const PHASE_ROOMS = { plan: { id: 'meeting', label: t('projectTypes.meetingRoom1f') }, design: { id: 'studio', label: t('projectTypes.b1DesignStudio') }, implement: { id: 'dev', label: t('projectTypes.devRoom2f') }, review: { id: 'lab', label: t('projectTypes.lab3f') }, report: { id: 'boss', label: t('projectTypes.ceosOffice4f') }, done: { id: 'boss', label: t('projectTypes.report4f') } };
