import { v3 } from '@tvox/core';
import { LevelDoc, OpDoc, PropDoc, VolumeDoc, levelFromDoc } from '../level-doc.js';
import { LevelSource } from '../level.js';
import { PORT_DOC } from './port.js';

export const EXPANDED_PORT_REVISION = 'lake-2026-10-10-v1';
export const ROAD_HEIGHT = 2.4;
export const FLOOD_LEVEL = 1.4;
/** Centre line of the full loop. The destroyed service bridge is outside it. */
export const RING_ROAD = [v3(45, 2.4, 85), v3(179, 2.4, 85), v3(179, 2.4, -169),
  v3(-99, 2.4, -169), v3(-99, 2.4, 85), v3(45, 2.4, 85)];
export const TUNNEL_BRANCH = [v3(40, 2.4, -169), v3(40, 2.4, -184), v3(40, 2.4, -244)];
export const NEW_PIER = v3(102, 0.4, -145);
export const HYDRO_POSITION = v3(-37, 2.4, 49);

function box(name: string, position: [number, number, number], size: [number, number, number],
  mat: string, voxelSize = 0.5, color?: string): VolumeDoc {
  return { name, position, size: size.map(n => Math.round(n / voxelSize)) as [number, number, number], voxelSize,
    grounded: true, structural: false, ops: [{ op: 'fill', mat, ...(color ? { color } : {}) }] };
}
const doc: LevelDoc = structuredClone(PORT_DOC);
doc.id = 'port-expanded'; doc.name = 'Порт · озеро и ГЭС';
doc.brief = 'Порт сохранён. Через южные ворота — кольцевая дорога вокруг озера. На дальнем берегу — причал; напротив порта — горный тоннель. ГЭС стоит на боковом канале: её разрушение отключит свет, вызовет паводок и обрушит служебный мост. Сигнализация имеет резервное питание.';
// The crane's transport quay and every yard/building volume remain byte-for-byte unchanged.
doc.volumes = doc.volumes.filter(v => !['pier', 'pier-parking-apron'].includes(v.name));
doc.vehicles.find(v => v.kind === 'boat')!.position = [112, -0.4, -145];
doc.vehicles.find(v => v.kind === 'boat')!.yaw = Math.PI / 2;
doc.environment = { ...doc.environment, daylight: doc.environment?.daylight ?? 'day', backdrop: undefined,
  lights: [...(doc.environment?.lights ?? []),
    { kind: 'point', position: [-37, 7, 44], color: '#ffe4b0', intensity: 7, range: 32 },
    { kind: 'point', position: [40, 8, -190], color: '#d8eaff', intensity: 6, range: 28 },
    { kind: 'point', position: [102, 5, -155], color: '#ffe4b0', intensity: 5, range: 24 }] };

function add(v: VolumeDoc) { doc.volumes.push(v); }
// Continuous terrain outside the loop: trees and mountains are reachable,
// not isolated pads above a void. It does not enter the original yard.
add(box('perimeter-land-west', [-164, -3.1, -270], [54, 5, 394], 'dirt', 1, '#667356'));
add(box('perimeter-land-east', [194, -3.1, -270], [80, 5, 394], 'dirt', 1, '#667356'));
add(box('perimeter-land-far', [-110, -3.1, -270], [304, 5, 90], 'dirt', 1, '#667356'));
add(box('perimeter-land-south', [-110, -3.1, 96], [304, 5, 28], 'dirt', 1, '#667356'));
// Solid, raised banks leave all water beside the main loop. Soil is coarse;
// buildings, pier and bridge use finer destructible voxels.
add(box('bank-west', [-110, -3.1, -180], [22, 5, 276], 'dirt', 1, '#667356'));
add(box('bank-east', [168, -3.1, -180], [26, 5, 276], 'dirt', 1, '#667356'));
add(box('bank-far', [-88, -3.1, -180], [256, 5, 22], 'dirt', 1, '#667356'));
add(box('bank-port', [-88, -3.1, 74], [256, 5, 22], 'dirt', 1, '#667356'));
doc.volumes.find(v => v.name === 'bank-port')!.ops.push(
  { op: 'fill', mat: 'air', box: [129, 0, 0, 137, 5, 10] },
  { op: 'fill', mat: 'air', box: [2, 0, 0, 10, 5, 10] });
doc.volumes.find(v => v.name === 'bank-far')!.ops.push({ op: 'fill', mat: 'air', box: [179, 3, 12, 201, 5, 22] });
add(box('south-low-shore-west', [-88, -2, 10], [88, 2, 64], 'dirt', 1, '#73765c'));
add(box('south-low-shore-east', [76, -2, 10], [92, 2, 64], 'dirt', 1, '#73765c'));
add(box('south-low-shore-gap', [0, -2, 64], [76, 2, 10], 'dirt', 1, '#73765c'));
// Dredged side channel, with a continuous foundation bed below flood water.
doc.volumes.find(v => v.name === 'south-low-shore-west')!.ops.push({ op: 'fill', mat: 'air', box: [28, 0, 0, 40, 2, 50] });
add(box('channel-bed', [-60, -4.5, 10], [12, 0.5, 50], 'foundation'));
add(box('lower-flood-bed', [-88, -4.5, -158], [256, 0.5, 232], 'foundation', 1));

add(box('road-north', [-104, 1.9, -174], [288, 0.5, 10], 'concrete', 0.5, '#484b4d'));
add(box('road-south', [-104, 1.9, 80], [288, 0.5, 10], 'concrete', 0.5, '#484b4d'));
add(box('road-west', [-104, 1.9, -164], [10, 0.5, 244], 'concrete', 0.5, '#484b4d'));
add(box('road-east', [174, 1.9, -164], [10, 0.5, 244], 'concrete', 0.5, '#484b4d'));
// Lane markings do not add collision steps above the pavement.
for (const v of doc.volumes.filter(v => v.name.startsWith('road-'))) {
  const longX = v.size[0] > v.size[2];
  v.ops.push({ op: 'grid', mat: 'concrete', color: '#e4d9a4',
    box: longX ? [0, 0, 9, v.size[0], 1, 10] : [9, 0, 0, 10, 1, v.size[2]],
    cell: longX ? [8, 1, 1] : [1, 1, 8], step: longX ? [20, 1, 1] : [1, 1, 20] });
}
// The existing eight metre gate is used as-is. A gently stepped ramp begins outside it.
const ramp = box('port-ring-ramp', [41, -0.6, 64], [8, 3, 20], 'air', 0.1);
for (let z = 0; z < 200; z++) ramp.ops.push({ op: 'fill', mat: 'concrete', color: '#66686a',
  box: [0, 0, z, 80, Math.min(30, 6 + Math.floor(z * 24 / 160)), z + 1] });
add(ramp);

// Far pier: cargo platform, grounded piles, truck/forklift apron and a driveable ramp.
const pier = box('far-pier', [96, -4, -158], [12, 4.4, 21], 'air', 0.2);
pier.structural = true;
pier.ops = [{ op: 'fill', box: [0, 20, 0, 60, 22, 105], mat: 'wood', color: '#917557' },
  { op: 'grid', box: [2, 0, 2, 60, 20, 105], cell: [3, 20, 3], step: [26, 25, 32], mat: 'metal' },
  { op: 'beams', y: 19, height: 1, spacingX: 15, spacingZ: 16, mat: 'metal', width: 2 }];
add(pier);
add(box('far-pier-apron', [91, -2.4, -162], [22, 2.8, 6], 'concrete', 0.2, '#777b78'));
const pierRamp = box('far-pier-ramp', [98, -2.4, -164], [8, 4.8, 10], 'air', 0.2);
for (let z = 0; z < 50; z++) pierRamp.ops.push({ op: 'fill', mat: 'concrete',
  box: [0, 0, z, 40, 14 + Math.round(Math.max(0, 1 - z / 49) * 10), z + 1] });
add(pierRamp);
const crate: PropDoc = { name: 'far-pier-cargo', kind: 'dynamic', tags: ['cargo'],
  volume: box('far-pier-cargo', [99, 0.4, -152], [1.6, 1.2, 1.6], 'wood', 0.2) };
crate.volume.grounded = false; crate.volume.structural = true; doc.props!.push(crate);

// A transverse T-branch. The road continues past the junction, never through the mountain.
add(box('tunnel-branch-bed', [32, -3.1, -256], [16, 5, 92], 'foundation', 1));
add(box('tunnel-road', [35, 1.9, -252], [10, 0.5, 88], 'concrete', 0.5, '#494c4e'));
const mountain = box('tunnel-mountain', [-16, -2.6, -240], [112, 34, 54], 'air', 1);
const mountainOps: OpDoc[] = [
  { op: 'fill', box: [0, 0, 0, 112, 12, 54], mat: 'rock', color: '#858b7e' },
  { op: 'fill', box: [7, 12, 5, 105, 22, 50], mat: 'rock', color: '#828979' },
  { op: 'fill', box: [20, 22, 12, 93, 28, 43], mat: 'rock', color: '#8e9486' },
  { op: 'fill', box: [37, 28, 18, 78, 34, 36], mat: 'rock', color: '#a6ada1' },
  { op: 'fill', box: [50, 5, 0, 62, 13, 54], mat: 'air' }];
mountain.ops = mountainOps; add(mountain);
// Portal lining: ceiling at 10.4m, eight metres above the road, fits the crane truck.
for (const z of [-240, -187]) {
  add(box(`tunnel-portal-left-${z}`, [32, 2.4, z], [2, 9, 2], 'concrete'));
  add(box(`tunnel-portal-right-${z}`, [46, 2.4, z], [2, 9, 2], 'concrete'));
  add(box(`tunnel-portal-top-${z}`, [32, 10.4, z], [16, 1, 2], 'concrete'));
}

// Hydropower lies south of the lake, on a side channel, wholly inside the loop.
add(box('hydro-service-ramp', [-86, -0.6, 64], [8, 3, 20], 'air', 0.2));
const serviceRamp = doc.volumes[doc.volumes.length - 1];
for (let z = 0; z < 100; z++) serviceRamp.ops.push({ op: 'fill', mat: 'concrete',
  box: [0, 0, z, 40, 3 + Math.min(12, Math.floor(z * 12 / 80)), z + 1] });
add(box('hydro-service-lane', [-86, -0.5, 34], [8, 0.5, 30], 'concrete'));
add(box('hydro-service-bank-west', [-86, -0.5, 34], [22, 1.5, 8], 'concrete'));
add(box('hydro-service-bank-east', [-44, -0.5, 34], [18, 1.5, 8], 'concrete'));
const bridgeApproach = box('hydro-bridge-approach', [-86, -0.6, 42], [8, 1.6, 8], 'air', 0.2);
for (let z = 0; z < 40; z++) bridgeApproach.ops.push({ op: 'fill', mat: 'concrete',
  box: [0, 0, z, 40, 3 + Math.round((1 - z / 39) * 5), z + 1] });
add(bridgeApproach);
const plantApproach = box('hydro-plant-approach', [-44, 0.4, 34], [12, 2, 10], 'air', 0.2);
for (let z = 0; z < 50; z++) plantApproach.ops.push({ op: 'fill', mat: 'concrete',
  box: [0, 0, z, 60, 3 + Math.round(z / 49 * 7), z + 1] });
add(plantApproach);
const bridge = box('hydro-service-bridge', [-64, -4, 34], [20, 5, 8], 'air', 0.5);
bridge.structural = true;
bridge.ops = [{ op: 'fill', box: [0, 9, 0, 40, 10, 16], mat: 'concrete' },
  { op: 'fill', box: [0, 0, 0, 4, 9, 16], mat: 'concrete' },
  { op: 'fill', box: [36, 0, 0, 40, 9, 16], mat: 'concrete' },
  { op: 'beams', y: 8, height: 1, spacingX: 8, spacingZ: 7, mat: 'metal', width: 1 }];
add(bridge);
add(box('hydro-plant-apron', [-46, -2, 42], [22, 4.4, 20], 'concrete', 0.5, '#858983'));
const plant = box('hydro-turbine-hall', [-44, 2.4, 44], [16, 10, 14], 'air', 0.5);
plant.structural = true;
plant.ops = [{ op: 'hollow', wall: 'brick', roof: 'metal', floor: 'concrete', thickness: 1 },
  { op: 'fill', box: [12, 0, 0, 24, 12, 1], mat: 'air' },
  { op: 'grid', box: [0, 6, 5, 32, 12, 24], cell: [1, 5, 4], step: [31, 20, 7], mat: 'glass' }];
add(plant);
const generator = box('hydro-generator', [-39, 2.4, 49], [4, 3, 4], 'metal', 0.5, '#4c8990');
generator.structural = true; add(generator);
add(box('reservoir-bed', [-72, -1.6, 58], [32, 0.5, 16], 'foundation', 0.5));
for (const [name, p, s] of [
  ['west', [-76, -2, 56], [4, 9, 22]], ['east', [-40, -2, 58], [4, 9, 20]],
  ['back', [-72, -2, 74], [32, 9, 4]], ['front-left', [-72, -2, 54], [12, 9, 4]],
  ['front-right', [-48, -2, 54], [8, 9, 4]],
] as [string, [number, number, number], [number, number, number]][]) add(box(`reservoir-bank-${name}`, p, s, 'rock', 1));
const dam = box('hydro-dam-core', [-60, -2, 54], [12, 9, 4], 'concrete', 0.5, '#9caaa6');
dam.structural = true; add(dam);

// Real destructible forest and outlying mountains, away from roads and the tunnel.
for (let i = 0; i < 42; i++) {
  const side = i % 3, n = Math.floor(i / 3);
  const x = side === 0 ? -120 - (n % 3) * 6 : side === 1 ? 202 + (n % 3) * 6 : -83 + n * 19;
  const z = side === 2 ? -201 - (n % 3) * 9 : -155 + n * 18;
  if (side === 2 && x > -20 && x < 105) continue;
  add(box(`forest-soil-${i}`, [x - 3, -1.6, z - 3], [6, 4, 6], 'dirt', 1));
  const tree = box(`forest-tree-${i}`, [x - 2, 2.4, z - 2], [5, 10, 5], 'air', 0.5);
  tree.structural = true;
  tree.ops = [{ op: 'fill', box: [4, 0, 4, 6, 15, 6], mat: 'wood', color: '#665443' },
    { op: 'fill', box: [0, 7, 0, 10, 12, 10], mat: 'foliage', color: '#496245' },
    { op: 'fill', box: [2, 12, 2, 8, 16, 8], mat: 'foliage', color: '#56744b' },
    { op: 'fill', box: [3, 16, 3, 7, 20, 7], mat: 'foliage', color: '#658452' }];
  add(tree);
}
for (const [i, x, z] of [[0, -150, -120], [1, 220, -100], [2, 130, -235]]) {
  const hill = box(`perimeter-mountain-${i}`, [x, -2, z], [40, 30, 48], 'air', 2);
  hill.ops = [{ op: 'fill', box: [0, 0, 0, 20, 7, 24], mat: 'rock', color: '#6d7969' },
    { op: 'fill', box: [3, 7, 3, 17, 12, 21], mat: 'rock', color: '#8a9685' },
    { op: 'fill', box: [6, 12, 7, 14, 15, 17], mat: 'rock', color: '#a3aea3' }]; add(hill);
}

// Water is passive volume geometry: translating its top requires no remeshing.
doc.props = doc.props!.filter(p => p.name !== 'harbour');
function water(name: string, x: number, z: number, width: number, depth: number, surface: number) {
  const volume = box(name, [x, surface - 8, z], [width, 8, depth], 'water', 1);
  volume.grounded = false;
  doc.props!.push({ name, kind: 'static', passive: true, tags: ['water'], volume });
}
water('lake-water', -88, -158, 256, 168, -0.4);
water('shore-flood-water', -88, 10, 256, 64, -0.4);
water('upper-reservoir-water', -72, 58, 32, 16, 6.4);

doc.revision = EXPANDED_PORT_REVISION;
doc.hydro = { critical: [{ volume: 'hydro-dam-core', minIntegrity: 0.68 }, { volume: 'hydro-generator', minIntegrity: 0.45 }],
    water: [{ body: 'lake-water', initial: -0.4, final: FLOOD_LEVEL },
      { body: 'shore-flood-water', initial: -0.4, final: FLOOD_LEVEL },
      { body: 'upper-reservoir-water', initial: 6.4, final: 1.4 }],
    bridge: { volume: 'hydro-service-bridge', scourBox: [0, 8, 0, 40, 9, 16],
      deckCuts: [[8, 9, 0, 9, 10, 16], [31, 9, 0, 32, 10, 16]], failLevel: 0.8 },
    warningSeconds: 8, floodSeconds: 90 };
doc.mapExits = [{ id: 'mountain-tunnel', center: [40, 4.4, -245], halfExtents: [6, 4, 4], enabled: false,
    destination: 'next-map', label: 'Выход из тоннеля · следующая карта появится позднее' }];
const source = levelFromDoc(doc);
export const EXPANDED_PORT_DOC = source.doc;
export const expandedPortLevel: LevelSource = source;
