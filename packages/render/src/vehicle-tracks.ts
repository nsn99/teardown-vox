import * as THREE from 'three';

export interface TrackMotion {
  center: { x: number; y: number; z: number };
  radius: number;
  halfStraight: number;
  width: number;
  travel: number;
  visible?: boolean;
}

/** Одна замкнутая лента: верх идёт вперёд, контактная часть — назад. */
export function trackShoeAt(track: TrackMotion, distance: number) {
  const straight = track.halfStraight * 2, curve = Math.PI * track.radius;
  const perimeter = 2 * (straight + curve);
  let d = ((distance % perimeter) + perimeter) % perimeter;
  let x: number, y: number, angle: number;
  if (d < straight) { x = -track.halfStraight + d; y = track.radius; angle = 0; }
  else if ((d -= straight) < curve) {
    const theta = Math.PI / 2 - d / track.radius;
    x = track.halfStraight + track.radius * Math.cos(theta); y = track.radius * Math.sin(theta); angle = theta - Math.PI / 2;
  } else if ((d -= curve) < straight) { x = track.halfStraight - d; y = -track.radius; angle = -Math.PI; }
  else {
    d -= straight; const theta = -Math.PI / 2 - d / track.radius;
    x = -track.halfStraight + track.radius * Math.cos(theta); y = track.radius * Math.sin(theta); angle = theta - Math.PI / 2;
  }
  return { x: x + track.center.x, y: y + track.center.y, z: track.center.z, angle, perimeter };
}

export class MovingTracks {
  readonly group = new THREE.Group();
  private belts: { mesh: THREE.InstancedMesh; previous: number }[];
  private material = new THREE.MeshStandardMaterial({ color: 0x7a838b, roughness: 0.9, metalness: 0.15 });
  private dummy = new THREE.Object3D();
  constructor(tracks: readonly TrackMotion[]) {
    this.belts = tracks.map(track => {
      const length = 4 * track.halfStraight + 2 * Math.PI * track.radius;
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.18, 0.075, track.width + 0.065), this.material, Math.ceil(length / 0.24));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.castShadow = true; mesh.receiveShadow = true;
      this.group.add(mesh); return { mesh, previous: NaN };
    });
    this.update(tracks);
    for (const { mesh } of this.belts) mesh.computeBoundingSphere();
  }
  update(tracks: readonly TrackMotion[]): void {
    for (const [i, track] of tracks.entries()) {
      const belt = this.belts[i]; belt.mesh.visible = track.visible !== false;
      if (belt.previous === track.travel) continue;
      const length = 4 * track.halfStraight + 2 * Math.PI * track.radius;
      for (let j = 0; j < belt.mesh.count; j++) {
        const p = trackShoeAt(track, j * length / belt.mesh.count + track.travel);
        this.dummy.position.set(p.x, p.y, p.z); this.dummy.rotation.set(0, 0, p.angle);
        this.dummy.updateMatrix(); belt.mesh.setMatrixAt(j, this.dummy.matrix);
      }
      belt.mesh.instanceMatrix.needsUpdate = true; belt.previous = track.travel;
    }
  }
  dispose(): void {
    this.group.removeFromParent();
    for (const { mesh } of this.belts) { mesh.dispose(); mesh.geometry.dispose(); }
    this.material.dispose();
  }
}
