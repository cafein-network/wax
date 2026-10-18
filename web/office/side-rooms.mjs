
export const WIDTH = 1424;
export const SCALE = 0.7;
export const FLOOR_HEIGHT = Math.round(420 * SCALE);
export const FLOOR = Math.round(300 * SCALE);
const FRONT = FLOOR + Math.round(72 * SCALE), BACK = FLOOR + Math.round(40 * SCALE);
export const PROP_BOTTOM = FLOOR + Math.round(62 * SCALE);
const CABINET_HEIGHT = 38;
const drinkStation = (x) => [
  { type: 'cabinet', x, w: 100 },
  { type: 'dispenser', x: x + 8, w: 30, bottom: PROP_BOTTOM - CABINET_HEIGHT },
  { type: 'espresso', x: x + 62, w: 32, bottom: PROP_BOTTOM - CABINET_HEIGHT },
];
export const DESK_SEAT_OFFSET = 4;
const DESK_SEAT = (deskX, w = 150) => Math.round(deskX + (w * (1 - SCALE)) / 2 + DESK_SEAT_OFFSET * SCALE);
export const LIFT_X = 1350;
export const LIFT_WIDTH = 96;

export const SEAT_GAP = 108;
const SPEAKER = { x: 884, w: 30, h: 20, bottom: PROP_BOTTOM };
const FREE_SEATS = { d0: [195, 'right'], d1: [305, 'left'], d2: [415, 'right'], d3: [525, 'left'], d4: [635, 'right'] };

export const CHAIR_STACK = { x: 18, gap: 7, count: 3 };
export const EXTRA_SEATS = ['meeting:w', 'meeting:sw', 'meeting:s', 'meeting:se', 'meeting:e',
  ...Object.keys(FREE_SEATS).map(seat => `dev:${seat}`), 'studio:a0', 'studio:a1', 'studio:a2'];

export const SIDE_ROOMS = {
  studio: {
    id: 'studio', label: '디자인실', floor: 'B1', background: 'studio', wall: '#dfe9e2', accent: '#93b7ab',
    NODES: {
      a0: [265, FRONT, 'right'], a1: [470, FRONT, 'right'], a2: [675, FRONT, 'right'],
      board0: [900, FRONT, 'right'], board1: [1090, BACK, 'left'],
      preview: [1160, FRONT, 'left'], mid: [770, BACK, 'right'],
      jenny: [805, FRONT, 'left'], jenny2: [1230, FRONT, 'left'],
    },
    SPOTS: { design: ['a0', 'a1', 'a2', 'board0', 'board1', 'preview', 'mid'] },
    SEATS: {
      a0: { x: 265, y: FRONT, facing: 'right', kind: 'chair' },
      a1: { x: 470, y: FRONT, facing: 'right', kind: 'chair' },
      a2: { x: 675, y: FRONT, facing: 'right', kind: 'chair' },
    },
    props: [
      { type: 'design-desk', x: 285, w: 160, seat: 'a0' }, { type: 'design-desk', x: 490, w: 160, seat: 'a1' }, { type: 'design-desk', x: 695, w: 160, seat: 'a2' },
      { type: 'moodboard', x: 930, w: 125 }, { type: 'softbox', x: 1140, w: 68 }, { type: 'plant', x: 20, w: 52 },
      ...drinkStation(110),
    ],
    board: { x: 940, y: PROP_BOTTOM - 100, width: 110, height: 100 },
  },
  dev: {
    id: 'dev', label: '개발실', floor: '2F', background: 'dev', wall: '#f1ece2', accent: '#d9e6dc',
    NODES: {
      door: [70, FRONT, 'right'], hall: [140, FRONT, 'right'], q: [120, BACK, 'right'],
      d0: [FREE_SEATS.d0[0], FRONT, FREE_SEATS.d0[1]], d1: [FREE_SEATS.d1[0], FRONT, FREE_SEATS.d1[1]], d2: [FREE_SEATS.d2[0], FRONT, FREE_SEATS.d2[1]],
      d3: [FREE_SEATS.d3[0], FRONT, FREE_SEATS.d3[1]], d4: [FREE_SEATS.d4[0], FRONT, FREE_SEATS.d4[1]],
      nook: [620, BACK, 'right'], mid: [655, BACK, 'right'], s2: [705, FRONT, 'right'], front: [700, BACK, 'right'],
      tl: [725, BACK, 'right'], fl: [745, FRONT, 'right'], fr: [835, FRONT, 'left'], tr: [860, BACK, 'left'],
      b0: [870, FRONT, 'right'], b1: [860, BACK, 'right'], b2: [1050, BACK, 'left'],
      lounge: [1040, FRONT, 'right'], sofa0: [1110, FRONT, 'left'], sofa1: [1180, FRONT, 'left'], rug: [1215, BACK, 'left'], coffee: [1250, FRONT, 'right'], nb2: [1295, BACK, 'left'],
    },
    SEATS: {
      ...Object.fromEntries(Object.entries(FREE_SEATS).map(([id, [x, facing]]) => [id, { x, y: FRONT, facing, kind: 'chair' }])),
      sofa0: { x: 1110, y: FRONT, facing: 'left', kind: 'sofa' }, sofa1: { x: 1180, y: FRONT, facing: 'left', kind: 'sofa' },
    },
    props: [
      { type: 'window', x: 170, w: 260 }, { type: 'window', x: 480, w: 260 }, { type: 'sign', x: 790, w: 150 },
      { type: 'table', x: 790, w: 110 }, { type: 'whiteboard', x: 895, w: 130 },
      { type: 'speaker', x: SPEAKER.x, w: SPEAKER.w, bottom: SPEAKER.bottom },
      { type: 'sofa', x: 1060, w: 160 }, ...drinkStation(1194), { type: 'door', x: 22, w: 96 }, { type: 'plant', x: 130, w: 60 },
    ],
    board: { x: 905, y: Math.round(225 * SCALE), width: 110, height: Math.round(80 * SCALE) },
    speaker: { x: SPEAKER.x - 6, y: SPEAKER.bottom - SPEAKER.h - 10, width: SPEAKER.w + 12, height: SPEAKER.h + 14 },
  },
  lab: {
    id: 'lab', label: '연구소', floor: '3F', background: 'lab', wall: '#26324a', accent: '#33425e', dark: true,
    NODES: {
      t0: [300, BACK, 'right'], t1: [510, BACK, 'right'], t2: [720, BACK, 'right'],
      m0: [900, BACK, 'right'], m1: [980, FRONT, 'right'], srv: [1120, FRONT, 'right'],
      m2: [405, BACK, 'right'], m3: [815, BACK, 'right'], m4: [265, FRONT, 'right'],
      nb: [600, FRONT, 'left'], nc: [1060, FRONT, 'left'],
    },
    SPOTS: { bench: ['t0', 't1', 't2'], monitor: ['m0', 'm1', 'srv', 'm2', 'm3', 'm4'] },
    SEATS: {},
    props: [
      ...drinkStation(12),
      { type: 'bugboard', x: 110, w: 120 }, { type: 'standdesk', x: 320, w: 130 }, { type: 'standdesk', x: 530, w: 130 }, { type: 'standdesk', x: 740, w: 130 },
      { type: 'dashboard', x: 900, w: 70 }, { type: 'dashboard', x: 985, w: 70 }, { type: 'devicefarm', x: 1150, w: 110 },
    ],
  },
  meeting: {
    id: 'meeting', label: '회의실', floor: '1F', background: 'meeting', wall: '#e9edf0', accent: '#cfdde4',
    NODES: {
      door: [70, FRONT, 'right'],
      stack: [120, BACK, 'left'],
      w: [330, FRONT, 'right'], sw: [385, BACK, 'right'], s: [440, FRONT, 'right'], p0: [505, BACK, 'right'],
      c0: [563, FRONT, 'right'], f0: [605, BACK, 'right'], c1: [647, FRONT, 'right'], f1: [703, BACK, 'right'],
      c2: [759, FRONT, 'left'], f2: [801, BACK, 'left'], c3: [843, FRONT, 'left'],
      p1: [905, BACK, 'left'], se: [960, FRONT, 'left'], e: [1020, BACK, 'left'], ne: [1090, FRONT, 'left'], n1: [1140, BACK, 'left'], board: [1190, FRONT, 'left'],
    },
    SPOTS: { meeting: ['c0', 'c1', 'c2', 'c3', 'f0', 'f1', 'f2', 'e', 'se', 's', 'sw', 'w'] },
    SEATS: {
      c0: { x: 563, y: FRONT, facing: 'right', kind: 'chair' }, c1: { x: 647, y: FRONT, facing: 'right', kind: 'chair' },
      c2: { x: 759, y: FRONT, facing: 'left', kind: 'chair' }, c3: { x: 843, y: FRONT, facing: 'left', kind: 'chair' },
      f0: { x: 605, y: BACK, facing: 'right', kind: 'chair' }, f1: { x: 703, y: BACK, facing: 'right', kind: 'chair' }, f2: { x: 801, y: BACK, facing: 'left', kind: 'chair' },
      w: { x: 330, y: FRONT, facing: 'right', kind: 'chair' }, sw: { x: 385, y: BACK, facing: 'right', kind: 'chair' }, s: { x: 440, y: FRONT, facing: 'right', kind: 'chair' },
      se: { x: 960, y: FRONT, facing: 'left', kind: 'chair' }, e: { x: 1020, y: BACK, facing: 'left', kind: 'chair' },
    },
    props: [
      { type: 'screen', x: 1080, w: 180 }, { type: 'longtable', x: 540, w: 340 },
      ...drinkStation(182), { type: 'whiteboard', x: 1120, w: 120 },
    ],
  },
  boss: {
    id: 'boss', label: '사장실', floor: '4F', background: 'boss', wall: '#efe4d3', accent: '#dccbb0',
    NODES: {
      sofa0: [220, FRONT, 'right'], sofa1: [290, FRONT, 'right'], center: [430, FRONT, 'right'], pm: [DESK_SEAT(520), FRONT, 'right'],
      chair: [DESK_SEAT(735, 170), FRONT, 'right'], v2: [900, BACK, 'left'], v0: [960, FRONT, 'left'], v1: [1040, FRONT, 'left'], front: [1110, BACK, 'left'],
    },
    SPOTS: { desk: 'chair', pmDesk: 'pm', visit: ['v0', 'v1', 'v2', 'front'], rest: ['sofa0', 'sofa1'] },
    SEATS: {
      chair: { x: DESK_SEAT(735, 170), y: FRONT, facing: 'right', kind: 'desk' },
      pm: { x: DESK_SEAT(520), y: FRONT, facing: 'right', kind: 'desk' },
      sofa0: { x: 220, y: FRONT, facing: 'right', kind: 'sofa' }, sofa1: { x: 290, y: FRONT, facing: 'right', kind: 'sofa' },
    },
    props: [{ type: 'shelf', x: 900, w: 240 }, { type: 'window', x: 380, w: 260 }, { type: 'bossdesk', x: 735, w: 170, seat: 'chair' }, { type: 'desk', x: 520, w: 150, seat: 'pm' }, { type: 'sofa', x: 170, w: 170 }, { type: 'plant', x: 1150, w: 60 }],
  },
  roof: {
    id: 'roof', label: '옥상 정원', floor: 'RF', background: 'roof', outdoor: true, wall: '#bfe0f2', accent: '#e8f4fa',
    NODES: {
      bench0: [285, FRONT, 'right'], bench1: [355, FRONT, 'right'],
      elder: [1035, BACK, 'left'], elder2: [150, FRONT, 'right'],
      a0: [560, FRONT, 'right'], a1: [680, FRONT, 'left'], a2: [580, BACK, 'right'], a3: [660, BACK, 'left'],
      p0: [860, FRONT, 'right'], p1: [980, FRONT, 'left'], p2: [880, BACK, 'right'], p3: [960, BACK, 'left'],
    },
    SPOTS: { rest: ['a0', 'a1', 'p0', 'p1', 'bench0', 'bench1', 'a2', 'a3', 'p2', 'p3'] },
    SEATS: {
      bench0: { x: 285, y: FRONT, facing: 'right', kind: 'sofa' }, bench1: { x: 355, y: FRONT, facing: 'right', kind: 'sofa' },
    },
    props: [
      { type: 'lawn', x: 20, w: 420, codeOnly: true }, { type: 'tree', x: 40, w: 150, codeOnly: true }, { type: 'planter', x: 1060, w: 220, codeOnly: true }, { type: 'gardenbench', x: 245, w: 150 },
      { type: 'bartable', x: 590, w: 60 }, { type: 'parasol', x: 840, w: 160 }, { type: 'plant', x: 450, w: 60 }, { type: 'plant', x: 760, w: 60 },
      { type: 'coffeecart', x: 1075, w: 104 }, { type: 'lantern', x: 205, w: 24 }, { type: 'lantern', x: 1200, w: 24 },
    ],
  },
};

const CHAIR_W = 52;
const emptyChair = (room, seat) => {
  const { x, facing } = room.SEATS[seat];
  const center = x + (facing === 'left' ? 8 : -8);
  return { type: 'chair', x: Math.round(center - CHAIR_W / 2), w: CHAIR_W, flip: facing === 'left', seatOf: seat };
};
SIDE_ROOMS.boss.props.unshift(emptyChair(SIDE_ROOMS.boss, 'chair'), emptyChair(SIDE_ROOMS.boss, 'pm'));
SIDE_ROOMS.meeting.props.unshift(...['f0', 'f1', 'f2'].map((seat) => emptyChair(SIDE_ROOMS.meeting, seat)));
SIDE_ROOMS.meeting.props.push(...['c0', 'c1', 'c2', 'c3'].map((seat) => emptyChair(SIDE_ROOMS.meeting, seat)));

export const FLOORS = ['studio', 'meeting', 'dev', 'lab', 'boss', 'roof'];
export const SIDE_ROOM_ORDER = FLOORS;

export function buildBuilding(rooms = SIDE_ROOMS, floors = FLOORS) {
  const height = FLOOR_HEIGHT * floors.length;
  const top = (index) => height - FLOOR_HEIGHT * (index + 1);
  const NODES = {}, SEATS = {}, EDGES = [], floorOf = {};
  floors.forEach((id, index) => {
    const room = rooms[id], dy = top(index);
    const lane = [];
    for (const [name, [x, y, facing]] of Object.entries(room.NODES)) {
      const key = `${id}:${name}`;
      NODES[key] = [x, y + dy, facing]; floorOf[key] = id;
      if (y === FRONT) { lane.push(key); continue; }
      const step = `${key}~`;
      NODES[step] = [x, FRONT + dy, facing]; floorOf[step] = id;
      lane.push(step); EDGES.push([step, key]);
    }
    NODES[`${id}:lift`] = [LIFT_X, FRONT + dy, 'left'];
    lane.push(`${id}:lift`);
    floorOf[`${id}:lift`] = id;
    for (const [name, seat] of Object.entries(room.SEATS)) SEATS[`${id}:${name}`] = { ...seat, y: seat.y + dy };
    lane.sort((a, b) => NODES[a][0] - NODES[b][0]);
    lane.slice(1).forEach((name, i) => EDGES.push([lane[i], name]));
    if (index > 0) EDGES.push([`${floors[index - 1]}:lift`, `${id}:lift`]);
  });
  return {
    id: 'building', label: '건물', side: true, scale: 1,
    SIZE: { width: WIDTH, height }, NODES, SEATS, EDGES, floorOf, floors,
    floorTop: Object.fromEntries(floors.map((id, i) => [id, top(i)])),
    SPOTS: { entrance: `${floors.includes('meeting') ? 'meeting' : floors[0]}:door` },
    WHITEBOARD_HIT: rooms.dev?.board ? { ...rooms.dev.board, y: rooms.dev.board.y + top(floors.indexOf('dev')) } : null,
    STUDIO_HIT: rooms.studio?.board ? { ...rooms.studio.board, y: rooms.studio.board.y + top(floors.indexOf('studio')) } : null,
    SPEAKER_HIT: rooms.dev?.speaker ? { ...rooms.dev.speaker, y: rooms.dev.speaker.y + top(floors.indexOf('dev')) } : null,
    rooms,
  };
}

export const BUILDING = buildBuilding();
