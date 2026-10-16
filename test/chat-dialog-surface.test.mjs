import test from 'node:test';
import assert from 'node:assert/strict';
import { createDialogSurface } from '../web/dialog-surface.mjs';

function fixture({ embedded = true, sameOrigin = true } = {}) {
  const agent = { id: 'agent-dialog', open: false, close() { this.open = false; } };
  const board = { id: 'board-dialog', open: false, close() { this.open = false; } };
  const document = (children = []) => {
    const doc = { children };
    doc.body = { append(node) {
      if (node.owner) node.owner.children = node.owner.children.filter((n) => n !== node);
      node.owner = doc; doc.children.push(node);
    } };
    doc.querySelectorAll = () => doc.children;
    doc.getElementById = (id) => doc.children.find((node) => node.id === id) ?? null;
    for (const node of children) node.owner = doc;
    return doc;
  };
  const parentDoc = document(), doc = document([agent, board]), events = {};
  const win = { document: doc, location: { search: embedded ? '?embed=1' : '' }, addEventListener(name, handler) { events[name] = handler; } };
  const frame = { id: 'office-frame', contentWindow: win };
  parentDoc.body.append(frame);
  win.parent = sameOrigin ? { document: parentDoc } : Object.defineProperty({}, 'document', { get() { throw new Error('cross-origin'); } });
  return { win, doc, parentDoc, agent, board, events };
}

test('대시보드 팝업만 부모 화면으로 옮기고 iframe의 사무실과 DOM 연결을 유지한다', () => {
  const f = fixture(), surface = createDialogSurface(f.win);
  assert.equal(f.agent.owner, f.parentDoc);
  assert.equal(f.board.owner, f.parentDoc);
  assert.equal(surface.getElementById('agent-dialog'), f.agent);
  assert.deepEqual(surface.dialogs, [f.agent, f.board]);
  f.agent.open = true;
  f.events.pagehide();
  assert.equal(f.agent.open, false);
  assert.equal(f.agent.owner, f.doc, 'iframe 제거 시 부모 화면에 팝업을 남기지 않는다');
  assert.equal(surface.getElementById('agent-dialog'), f.agent);
  f.events.pageshow();
  assert.equal(f.agent.owner, f.parentDoc, '뒤로 가기로 복원되면 다시 부모 화면을 사용한다');
});

test('단독 사무실과 접근할 수 없는 부모는 원래 문서에서 팝업을 연다', () => {
  for (const options of [{ embedded: false }, { sameOrigin: false }]) {
    const f = fixture(options), surface = createDialogSurface(f.win);
    assert.equal(f.agent.owner, f.doc);
    assert.equal(surface.getElementById('board-dialog'), f.board);
  }
});

test('이름이 같은 임의의 부모 iframe에는 팝업을 옮기지 않는다', () => {
  const f = fixture();
  f.parentDoc.getElementById('office-frame').contentWindow = {};
  createDialogSurface(f.win);
  assert.equal(f.agent.owner, f.doc);
});
