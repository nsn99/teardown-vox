import * as THREE from 'three';

/** Невысокополигонный дальний берег: не добавляет ни одного физического тела. */
export function createPortBackdrop(): THREE.Group {
  const group = new THREE.Group(); group.name = 'port-hills';
  let seed = 72913;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const ground = new THREE.MeshLambertMaterial({ color: 0x6b7356, flatShading: true });
  for (const [x, z, width, depth] of [[-51, 84, 78, 140], [138, 90, 124, 140], [32, 150, 90, 172]]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.2, depth), ground);
    mesh.position.set(x, -0.15, z); group.add(mesh);
  }
  const shore = new THREE.Mesh(new THREE.RingGeometry(185, 430, 64), ground);
  shore.rotation.x = -Math.PI / 2; shore.position.set(38, -1.8, 32); group.add(shore);
  const hills = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), 36);
  const peaks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshLambertMaterial({ color: 0x818d80, flatShading: true }), 12);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 36; i++) {
    const angle = i * Math.PI * 2 / 36, distance = 235 + random() * 60;
    const radius = 46 + random() * 35, height = 22 + random() * 28;
    const x = 38 + Math.cos(angle) * distance, z = 32 + Math.sin(angle) * distance;
    const yaw = random() * Math.PI;
    dummy.position.set(x, -2, z); dummy.rotation.set(0, yaw, 0); dummy.scale.set(radius, height, radius * (0.8 + random() * 0.5));
    dummy.updateMatrix(); hills.setMatrixAt(i, dummy.matrix);
    hills.setColorAt(i, new THREE.Color(0x7d8967).multiplyScalar(0.8 + random() * 0.25));
    if (i % 3 === 0) {
      dummy.position.set(x * 1.2, 10, z * 1.2); dummy.scale.set(radius * 0.8, 42 + random() * 23, radius);
      dummy.updateMatrix(); peaks.setMatrixAt(i / 3, dummy.matrix);
    }
  }
  group.add(hills, peaks);
  const trees = 720;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.27, 1, 5),
    new THREE.MeshLambertMaterial({ color: 0x62584c }), trees);
  const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 6),
    new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), trees * 3);
  for (let i = 0; i < trees; i++) {
    const side = i % 3;
    const x = side === 0 ? -16 - random() * 65 : side === 1 ? 81 + random() * 100 : -12 + random() * 100;
    const z = side === 2 ? 69 + random() * 110 : 17 + random() * 130;
    const height = 4.5 + random() * 5, radius = 1.2 + random() * 1.2;
    dummy.rotation.set(0, random() * Math.PI, 0);
    dummy.position.set(x, height * 0.24, z); dummy.scale.set(1, height * 0.48, 1);
    dummy.updateMatrix(); trunks.setMatrixAt(i, dummy.matrix);
    for (let layer = 0; layer < 3; layer++) {
      const h = height * (0.55 - layer * 0.09), r = radius * (1 - layer * 0.24);
      dummy.position.set(x, height * (0.38 + layer * 0.21), z); dummy.scale.set(r, h, r);
      dummy.updateMatrix(); crowns.setMatrixAt(i * 3 + layer, dummy.matrix);
      crowns.setColorAt(i * 3 + layer, new THREE.Color(0x536745).multiplyScalar(0.8 + random() * 0.35));
    }
  }
  group.add(trunks, crowns);
  for (const mesh of [hills, peaks, trunks, crowns]) mesh.computeBoundingSphere();
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
