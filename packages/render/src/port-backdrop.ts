import * as THREE from 'three';

/** Невысокополигонный дальний берег: не добавляет ни одного физического тела. */
export function createPortBackdrop(): THREE.Group {
  const group = new THREE.Group(); group.name = 'port-hills';
  let seed = 72913;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const ground = new THREE.MeshLambertMaterial({ color: 0x526752, flatShading: true });
  for (const [x, z, width, depth] of [[-51, 84, 78, 140], [138, 90, 124, 140], [32, 150, 90, 172]]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.2, depth), ground);
    mesh.position.set(x, -0.15, z); group.add(mesh);
  }
  const shore = new THREE.Mesh(new THREE.RingGeometry(185, 430, 64), ground);
  shore.rotation.x = -Math.PI / 2; shore.position.set(38, -1.8, 32); group.add(shore);
  const peaks = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7),
    new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), 28);
  const snow = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7),
    new THREE.MeshLambertMaterial({ color: 0xd0dbd8, flatShading: true }), 28);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 28; i++) {
    const angle = i * Math.PI * 2 / 28, distance = 250 + random() * 50;
    const radius = 40 + random() * 32, height = 45 + random() * 80;
    const x = 38 + Math.cos(angle) * distance, z = 32 + Math.sin(angle) * distance;
    const yaw = random() * Math.PI;
    dummy.position.set(x, height / 2 - 2, z); dummy.rotation.set(0, yaw, 0); dummy.scale.set(radius, height, radius * (0.8 + random() * 0.5));
    dummy.updateMatrix(); peaks.setMatrixAt(i, dummy.matrix);
    const color = new THREE.Color(0x71877c).multiplyScalar(0.7 + random() * 0.35); peaks.setColorAt(i, color);
    dummy.position.y = height * 0.89 - 2; dummy.scale.multiplyScalar(0.22);
    dummy.updateMatrix(); snow.setMatrixAt(i, dummy.matrix);
  }
  group.add(peaks, snow);
  const trees = 280;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.27, 1, 5),
    new THREE.MeshLambertMaterial({ color: 0x62584c }), trees);
  const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 6),
    new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), trees * 2);
  for (let i = 0; i < trees; i++) {
    const side = i % 3;
    const x = side === 0 ? -16 - random() * 65 : side === 1 ? 81 + random() * 100 : -12 + random() * 100;
    const z = side === 2 ? 69 + random() * 110 : 17 + random() * 130;
    const height = 3.5 + random() * 4, radius = 1.0 + random() * 1.0;
    dummy.rotation.set(0, random() * Math.PI, 0);
    dummy.position.set(x, height * 0.24, z); dummy.scale.set(1, height * 0.48, 1);
    dummy.updateMatrix(); trunks.setMatrixAt(i, dummy.matrix);
    for (let layer = 0; layer < 2; layer++) {
      const h = height * (layer ? 0.52 : 0.64), r = radius * (layer ? 0.7 : 1);
      dummy.position.set(x, height * (layer ? 0.72 : 0.49), z); dummy.scale.set(r, h, r);
      dummy.updateMatrix(); crowns.setMatrixAt(i * 2 + layer, dummy.matrix);
      crowns.setColorAt(i * 2 + layer, new THREE.Color(0x547b58).multiplyScalar(0.65 + random() * 0.3));
    }
  }
  group.add(trunks, crowns);
  for (const mesh of [peaks, snow, trunks, crowns]) mesh.computeBoundingSphere();
  return group;
}

export function disposePortBackdrop(group: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  group.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    if (object instanceof THREE.InstancedMesh) object.dispose();
  });
  group.removeFromParent();
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}
