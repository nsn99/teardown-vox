import * as THREE from 'three';

/** Состояние заряда приходит из игры; рендер не создаёт физические тела. */
export class ChargeView {
  readonly group = new THREE.Group();
  private readonly geometry = new THREE.BoxGeometry(0.18, 0.12, 0.10);
  private readonly material = new THREE.MeshStandardMaterial({ color: 0xf07d32, emissive: 0x661500, roughness: 0.65 });
  private readonly meshes = new Map<number, THREE.Mesh>();

  update(charges: readonly { id: number; position: { x: number; y: number; z: number } }[]): void {
    const live = new Set(charges.map(c => c.id));
    for (const [id, mesh] of this.meshes) {
      if (live.has(id)) continue;
      this.group.remove(mesh);
      this.meshes.delete(id);
    }
    for (const charge of charges) {
      let mesh = this.meshes.get(charge.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.geometry, this.material);
        mesh.castShadow = true;
        this.meshes.set(charge.id, mesh);
        this.group.add(mesh);
      }
      mesh.position.set(charge.position.x, charge.position.y, charge.position.z);
    }
  }

  dispose(): void {
    this.update([]);
    this.geometry.dispose();
    this.material.dispose();
  }
}
