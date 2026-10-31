export const SIZE = { width: 1424, height: 848 };

export const NODES = {
  door: [905, 352, 'left'],
  hall: [820, 368, 'left'],
  d0: [312, 515, 'left'],
  d1: [602, 402, 'left'],
  d2: [556, 690, 'left'],
  d3: [420, 610, 'right'],
  d4: [300, 660, 'right'],
  tl: [598, 472, 'right'],
  tr: [905, 452, 'left'],
  fl: [680, 548, 'right'],
  fr: [832, 546, 'left'],
  mid: [470, 482, 'right'],
  q: [238, 592, 'right'],
  s2: [662, 620, 'left'],
  b0: [962, 446, 'right'],
  b1: [905, 404, 'right'],
  b2: [1012, 502, 'right'],
  sofa0: [1086, 472, 'left'],
  sofa1: [1150, 496, 'left'],
  rug: [1052, 622, 'right'],
  coffee: [1176, 602, 'right'],
  nook: [700, 330, 'right'],
  lounge: [985, 575, 'left'],
  front: [760, 600, 'right'],
};

export const EDGES = [
  ['door', 'hall'], ['door', 'b1'], ['hall', 'b1'], ['hall', 'd1'], ['d1', 'tl'], ['d1', 'mid'],
  ['mid', 'd0'], ['mid', 'tl'], ['d0', 'q'], ['tl', 'fl'], ['fl', 'fr'], ['fr', 'tr'], ['tr', 'b1'],
  ['tr', 'b0'], ['b1', 'b0'], ['b0', 'b2'], ['b2', 'sofa0'], ['sofa0', 'sofa1'], ['b2', 'rug'],
  ['rug', 'coffee'], ['sofa1', 'coffee'], ['fl', 's2'], ['s2', 'd2'],
  ['nook', 'hall'], ['nook', 'd1'], ['lounge', 'rug'], ['lounge', 'b2'], ['lounge', 'fr'], ['front', 's2'], ['front', 'fl'], ['front', 'fr'], ['d3', 's2'], ['d3', 'q'], ['d4', 'q'],
];

export const SPOTS = {
  entrance: 'door',
  desks: ['d0', 'd1', 'd2', 'd3', 'd4'],
  extras: ['mid', 'q', 'rug', 's2', 'nook', 'lounge', 'front'],
  meeting: ['tl', 'tr', 'fl', 'fr'],
  board: ['b0', 'b1', 'b2'],
  rest: ['sofa0', 'sofa1', 'coffee'],
};

export const SEATS = {
  d0: { x: 292, y: 474, facing: 'left', occluder: 'd0', back: { dx: 12, dy: -38 }, sleep: { dx: 4, dy: -14 } },
  d1: { x: 584, y: 338, facing: 'left', occluder: 'd1', back: { dx: 6, dy: -36 }, sleep: { dx: 4, dy: -14 } },
  d2: { x: 534, y: 644, facing: 'left', occluder: 'd2', back: { dx: 14, dy: -38 }, sleep: { dx: 4, dy: -14 } },
  d3: { x: 420, y: 600, facing: 'right', back: { dx: 0, dy: -20 }, sleep: { dx: 0, dy: -10 } },
  d4: { x: 300, y: 650, facing: 'right', back: { dx: 0, dy: -20 }, sleep: { dx: 0, dy: -10 } },
  sofa0: { x: 1058, y: 422, facing: 'left' },
  sofa1: { x: 1122, y: 448, facing: 'left' },
};

export const WHITEBOARD = { tl: [1022, 132], tr: [1258, 240], bl: [1022, 262], br: [1258, 354] };
export const WHITEBOARD_HIT = { x: 1010, y: 118, width: 262, height: 250 };
