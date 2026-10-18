import * as dev from './layout.mjs';

export const ROOMS = {
  dev: {
    id: 'dev', label: '개발실', background: null, scale: 1.3,
    SIZE: dev.SIZE, NODES: dev.NODES, EDGES: dev.EDGES, SPOTS: dev.SPOTS, SEATS: dev.SEATS,
    WHITEBOARD: dev.WHITEBOARD, WHITEBOARD_HIT: dev.WHITEBOARD_HIT,
  },
  meeting: {
    id: 'meeting', label: '회의실', background: 'meeting', scale: 1.4,
    SIZE: dev.SIZE,
    NODES: {
      door: [830, 318, 'left'],
      n1: [1010, 350, 'right'],
      ne: [1090, 445, 'left'],
      board: [1160, 485, 'left'],
      e: [1115, 565, 'left'],
      se: [1060, 700, 'left'],
      s: [820, 745, 'left'],
      sw: [560, 705, 'right'],
      w: [320, 600, 'right'],
      p0: [470, 690, 'right'],
      p1: [900, 730, 'left'],
      c0: [440, 575, 'right'],
      c1: [570, 625, 'right'],
      c2: [700, 680, 'right'],
      c3: [985, 680, 'left'],
      f0: [745, 292, 'left'],
      f1: [880, 345, 'left'],
      f2: [1010, 400, 'left'],
    },
    EDGES: [
      ['door', 'n1'], ['n1', 'ne'], ['ne', 'board'], ['ne', 'e'], ['board', 'e'], ['e', 'se'], ['se', 's'], ['s', 'sw'], ['sw', 'w'],
      ['w', 'c0'], ['sw', 'c0'], ['sw', 'c1'], ['s', 'c2'], ['sw', 'c2'], ['se', 'c3'], ['s', 'c3'], ['sw', 'p0'], ['s', 'p1'], ['se', 'p1'],
      ['door', 'f0'], ['door', 'f1'], ['n1', 'f1'], ['n1', 'f2'], ['ne', 'f2'],
    ],
    SPOTS: { entrance: 'door', meeting: ['c0', 'c1', 'c2', 'c3', 'f0', 'f1', 'f2', 'e', 'se', 's', 'sw', 'w'] },
    SEATS: {
      c0: { x: 462, y: 492, facing: 'right', occluder: 'meeting-m0', back: { dx: 4, dy: -78 } },
      c1: { x: 590, y: 545, facing: 'right', occluder: 'meeting-m1', back: { dx: 4, dy: -78 } },
      c2: { x: 720, y: 602, facing: 'right', occluder: 'meeting-m2', back: { dx: 4, dy: -78 } },
      c3: { x: 962, y: 598, facing: 'left', occluder: 'meeting-m3', back: { dx: -4, dy: -78 } },
      f0: { x: 712, y: 368, facing: 'left', occluder: 'meeting-table', front: true },
      f1: { x: 842, y: 424, facing: 'left', occluder: 'meeting-table', front: true },
      f2: { x: 968, y: 474, facing: 'left', occluder: 'meeting-table', front: true },
      w: { x: 320, y: 600, facing: 'right' }, sw: { x: 560, y: 705, facing: 'right' }, s: { x: 820, y: 745, facing: 'left' },
      se: { x: 1060, y: 700, facing: 'left' }, e: { x: 1115, y: 565, facing: 'left' },
    },
    WHITEBOARD: null, WHITEBOARD_HIT: null,
  },
  boss: {
    id: 'boss', label: '사장실', background: 'boss', scale: 1.45,
    SIZE: dev.SIZE,
    NODES: {
      door: [920, 428, 'left'],
      center: [790, 520, 'left'],
      chair: [690, 585, 'left'],
      pm: [560, 600, 'right'],
      v0: [540, 640, 'right'],
      v1: [430, 700, 'right'],
      v2: [700, 690, 'left'],
      front: [880, 660, 'left'],
      sofa0: [1130, 590, 'left'],
      sofa1: [1175, 610, 'left'],
    },
    EDGES: [
      ['door', 'center'], ['center', 'chair'], ['center', 'v2'], ['v2', 'v0'], ['v0', 'v1'], ['chair', 'v2'],
      ['center', 'front'], ['front', 'v2'], ['front', 'sofa0'], ['sofa0', 'sofa1'], ['center', 'pm'],
    ],
    SPOTS: { entrance: 'door', desk: 'chair', pmDesk: 'pm', visit: ['v0', 'v1', 'v2', 'front'], rest: ['sofa0', 'sofa1'] },
    SEATS: {
      chair: { x: 650, y: 498, facing: 'left', occluder: 'boss-chair', back: { dx: 4, dy: -86 }, sleep: { dx: 4, dy: -60 } },
      pm: { x: 540, y: 520, facing: 'right' },
      sofa0: { x: 1015, y: 478, facing: 'left' },
      sofa1: { x: 1098, y: 500, facing: 'left' },
    },
    WHITEBOARD: null, WHITEBOARD_HIT: null,
  },
};

export const ROOM_ORDER = ['dev', 'meeting', 'boss'];
export const roomOf = (id) => ROOMS[id] ?? ROOMS.dev;
