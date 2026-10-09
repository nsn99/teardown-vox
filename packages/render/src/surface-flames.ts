import * as THREE from 'three';
import { Vec3 } from '@tvox/core';

/** Persistent tongues of flame at every burning region, separate from the debris pool. */
export class SurfaceFlames {
  readonly mesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private readonly material: THREE.ShaderMaterial;
  constructor(private capacity = 4000) {
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: { time: { value: 0 } },
      vertexShader: `varying vec2 vUv; varying float seed;
        void main() { vUv=uv; seed=instanceMatrix[3].x*3.7+instanceMatrix[3].z*5.3;
          gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0); }`,
      fragmentShader: `uniform float time; varying vec2 vUv; varying float seed;
        void main() {
          float y=vUv.y;
          float sway=sin(y*12.0-time*9.0+seed)*.09*y+sin(time*5.0+seed)*.035;
          float width=mix(.46,.025,y)*(1.0+.16*sin(y*21.0-time*13.0+seed));
          float edge=1.0-smoothstep(width*.45,width,abs(vUv.x-.5-sway));
          float alpha=edge*(1.0-smoothstep(.65,1.0,y))*.8;
          if(alpha<.015) discard;
          vec3 color=mix(vec3(1.0,.9,.35),vec3(1.0,.12,.015),smoothstep(.1,.85,y));
          gl_FragColor=vec4(color,alpha);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.material, capacity * 2);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.name = 'surface-flames';
  }
  update(points: Iterable<{ position: Vec3; heat: number }>, time: number): void {
    this.material.uniforms.time.value = time;
    const regions = new Set<string>(); let count = 0;
    for (const { position: p, heat } of points) {
      const key = `${Math.floor(p.x / .3)},${Math.floor(p.y / .3)},${Math.floor(p.z / .3)}`;
      if (regions.has(key)) continue;
      if (regions.size >= this.capacity) break;
      regions.add(key);
      const height = .3 + Math.max(.1, heat) * .55;
      this.dummy.position.set(p.x, p.y + height * .4, p.z);
      this.dummy.scale.set(.38, height, 1);
      for (let side = 0; side < 2; side++) {
        this.dummy.rotation.set(0, side * Math.PI / 2, 0); this.dummy.updateMatrix();
        this.mesh.setMatrixAt(count++, this.dummy.matrix);
      }
    }
    this.mesh.count = count; this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear(): void { this.mesh.count = 0; }
}
