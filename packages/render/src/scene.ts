import * as THREE from 'three';
import { Body, VoxelShape, VoxelWorld, regionIsEmpty } from '@tvox/core';
import { MeshData, meshShape } from './mesher.js';

export type Quality = 'low' | 'medium' | 'high';

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  quality?: Quality;
  /** Ребро чанка в вокселях. Меньше — точнее ремеш, больше — меньше вызовов отрисовки. */
  chunkSize?: number;
  /** Сколько чанков перестраиваем за кадр. */
  remeshBudget?: number;
  /** Дальность прорисовки, м. */
  viewDistance?: number;
}

interface ChunkEntry {
  key: string;
  shape: VoxelShape;
  body: Body;
  cx: number;
  cy: number;
  cz: number;
  opaque: THREE.Mesh;
  glass: THREE.Mesh;
  dirty: boolean;
  /** Мировая позиция центра чанка — для сортировки по расстоянию. */
  center: THREE.Vector3;
}

const QUALITY = {
  low: { shadowMap: 0, pixelRatio: 0.75, ao: 0.3 },
  medium: { shadowMap: 2048, pixelRatio: 1, ao: 0.35 },
  high: { shadowMap: 4096, pixelRatio: 1.5, ao: 0.4 },
} as const;

/**
 * Отрисовка воксельного мира.
 *
 * Каждая форма нарезана на чанки; перестраивается только тот чанк, который
 * задело разрушение, и не больше нескольких штук за кадр. Иначе один удар
 * кувалдой по складу заставлял бы пересобирать полмиллиона вокселей в кадре.
 */
export class VoxelRenderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly sun: THREE.DirectionalLight;

  private groups = new Map<number, THREE.Group>();
  private chunks = new Map<string, ChunkEntry>();
  private shapeChunks = new Map<number, ChunkEntry[]>();
  private opaqueMaterial: THREE.MeshStandardMaterial;
  private glassMaterial: THREE.MeshStandardMaterial;
  private chunkSize: number;
  private remeshBudget: number;
  private aoStrength: number;
  private seenShapes = new Set<number>();

  /** Метрики последнего кадра — для перф-регрессии. */
  stats = { chunks: 0, remeshed: 0, quads: 0, triangles: 0 };

  constructor(opts: RendererOptions) {
    const quality = QUALITY[opts.quality ?? 'medium'];
    this.chunkSize = opts.chunkSize ?? 32;
    this.remeshBudget = opts.remeshBudget ?? 6;
    this.aoStrength = quality.ao;

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: (opts.quality ?? 'medium') !== 'low',
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
    this.renderer.shadowMap.enabled = quality.shadowMap > 0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.camera = new THREE.PerspectiveCamera(
      75,
      1,
      0.05,
      opts.viewDistance ?? 300,
    );

    this.scene.background = new THREE.Color(0x1b2a3a);
    this.scene.fog = new THREE.Fog(0x1b2a3a, 60, opts.viewDistance ?? 300);

    const hemi = new THREE.HemisphereLight(0xa8c4e0, 0x3a352e, 0.95);
    this.scene.add(hemi);

    // Ночной порт: низкое холодное «солнце» плюс тёплые прожекторы.
    this.sun = new THREE.DirectionalLight(0xffeeda, 1.7);
    this.sun.position.set(-40, 60, 30);
    this.sun.castShadow = quality.shadowMap > 0;
    if (this.sun.shadow) {
      this.sun.shadow.mapSize.set(quality.shadowMap || 1, quality.shadowMap || 1);
      const cam = this.sun.shadow.camera as THREE.OrthographicCamera;
      cam.left = -45;
      cam.right = 45;
      cam.top = 45;
      cam.bottom = -45;
      cam.near = 1;
      cam.far = 200;
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.05;
    }
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Подсветка «с воды»: без неё теневая сторона склада — чёрный силуэт,
    // в котором не видно ни материала, ни проёма.
    const fill = new THREE.DirectionalLight(0x7fa8d8, 0.45);
    fill.position.set(35, 25, -40);
    this.scene.add(fill);

    this.opaqueMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.06,
      flatShading: true,
    });
    this.glassMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.08,
      metalness: 0.15,
      transparent: true,
      opacity: 0.4,
      flatShading: true,
      side: THREE.DoubleSide,
    });
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  setCamera(position: { x: number; y: number; z: number }, yaw: number, pitch: number): void {
    this.camera.position.set(position.x, position.y, position.z);
    this.camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  /** Подтягивает сцену под текущее состояние мира. */
  sync(world: VoxelWorld): void {
    this.seenShapes.clear();

    for (const body of world.bodies.values()) {
      if (body.destroyed) continue;
      let group = this.groups.get(body.id);
      if (!group) {
        group = new THREE.Group();
        this.scene.add(group);
        this.groups.set(body.id, group);
      }
      group.position.set(body.transform.position.x, body.transform.position.y, body.transform.position.z);
      group.quaternion.set(
        body.transform.rotation.x,
        body.transform.rotation.y,
        body.transform.rotation.z,
        body.transform.rotation.w,
      );

      for (const shape of body.shapes) {
        this.seenShapes.add(shape.id);
        this.ensureChunks(body, shape, group);
        this.markDirty(shape);
      }
    }

    this.dropGoneShapes();
    this.dropGoneBodies(world);
    this.remesh();
  }

  private ensureChunks(body: Body, shape: VoxelShape, group: THREE.Group): void {
    if (this.shapeChunks.has(shape.id)) return;
    const cs = this.chunkSize;
    const s = shape.voxelSize;
    const list: ChunkEntry[] = [];
    const holder = new THREE.Group();
    holder.position.set(shape.transform.position.x, shape.transform.position.y, shape.transform.position.z);
    holder.quaternion.set(
      shape.transform.rotation.x,
      shape.transform.rotation.y,
      shape.transform.rotation.z,
      shape.transform.rotation.w,
    );
    group.add(holder);

    for (let cy = 0; cy * cs < shape.sy; cy++) {
      for (let cz = 0; cz * cs < shape.sz; cz++) {
        for (let cx = 0; cx * cs < shape.sx; cx++) {
          const opaque = new THREE.Mesh(new THREE.BufferGeometry(), this.opaqueMaterial);
          const glass = new THREE.Mesh(new THREE.BufferGeometry(), this.glassMaterial);
          opaque.castShadow = true;
          opaque.receiveShadow = true;
          opaque.frustumCulled = true;
          glass.frustumCulled = true;
          opaque.position.set(cx * cs * s, cy * cs * s, cz * cs * s);
          glass.position.copy(opaque.position);
          holder.add(opaque, glass);

          const entry: ChunkEntry = {
            key: `${shape.id}:${cx},${cy},${cz}`,
            shape,
            body,
            cx,
            cy,
            cz,
            opaque,
            glass,
            dirty: true,
            center: new THREE.Vector3(),
          };
          this.chunks.set(entry.key, entry);
          list.push(entry);
        }
      }
    }
    this.shapeChunks.set(shape.id, list);
  }

  private markDirty(shape: VoxelShape): void {
    const region = shape.dirtyMesh;
    if (regionIsEmpty(region)) return;
    const cs = this.chunkSize;
    const list = this.shapeChunks.get(shape.id);
    if (!list) return;
    // Захватываем соседние чанки: грань на шве зависит от вокселя за границей.
    const x0 = Math.floor((region.x0 - 1) / cs);
    const y0 = Math.floor((region.y0 - 1) / cs);
    const z0 = Math.floor((region.z0 - 1) / cs);
    const x1 = Math.floor(region.x1 / cs);
    const y1 = Math.floor(region.y1 / cs);
    const z1 = Math.floor(region.z1 / cs);
    for (const c of list) {
      if (c.cx >= x0 && c.cx <= x1 && c.cy >= y0 && c.cy <= y1 && c.cz >= z0 && c.cz <= z1) {
        c.dirty = true;
      }
    }
    shape.clearMeshDirty();
  }

  private dropGoneShapes(): void {
    for (const [shapeId, list] of this.shapeChunks) {
      if (this.seenShapes.has(shapeId)) continue;
      for (const c of list) {
        c.opaque.geometry.dispose();
        c.glass.geometry.dispose();
        c.opaque.parent?.remove(c.opaque);
        c.glass.parent?.remove(c.glass);
        this.chunks.delete(c.key);
      }
      this.shapeChunks.delete(shapeId);
    }
  }

  private dropGoneBodies(world: VoxelWorld): void {
    for (const [bodyId, group] of this.groups) {
      const body = world.bodies.get(bodyId);
      if (body && !body.destroyed) continue;
      this.scene.remove(group);
      this.groups.delete(bodyId);
    }
  }

  private remesh(): void {
    const dirty: ChunkEntry[] = [];
    for (const c of this.chunks.values()) if (c.dirty) dirty.push(c);
    this.stats.chunks = this.chunks.size;
    if (dirty.length === 0) {
      this.stats.remeshed = 0;
      return;
    }

    // Ближние чанки важнее: игрок смотрит на дыру, которую только что пробил.
    const cam = this.camera.position;
    for (const c of dirty) {
      c.opaque.getWorldPosition(c.center);
      (c as { dist?: number }).dist = c.center.distanceToSquared(cam);
    }
    dirty.sort(
      (a, b) => ((a as { dist?: number }).dist ?? 0) - ((b as { dist?: number }).dist ?? 0),
    );

    const budget = Math.min(this.remeshBudget, dirty.length);
    for (let i = 0; i < budget; i++) this.rebuild(dirty[i]);
    this.stats.remeshed = budget;
  }

  private rebuild(entry: ChunkEntry): void {
    const cs = this.chunkSize;
    const region = {
      x0: entry.cx * cs,
      y0: entry.cy * cs,
      z0: entry.cz * cs,
      x1: Math.min(entry.shape.sx, (entry.cx + 1) * cs),
      y1: Math.min(entry.shape.sy, (entry.cy + 1) * cs),
      z1: Math.min(entry.shape.sz, (entry.cz + 1) * cs),
    };
    const common = { region, originAtRegion: true, aoStrength: this.aoStrength };
    applyMesh(entry.opaque, meshShape(entry.shape, { ...common, pass: 'opaque' }));
    applyMesh(entry.glass, meshShape(entry.shape, { ...common, pass: 'transparent' }));
    entry.dirty = false;
  }

  render(): void {
    let quads = 0;
    let tris = 0;
    for (const c of this.chunks.values()) {
      const idx = c.opaque.geometry.getIndex();
      if (idx) tris += idx.count / 3;
      const gidx = c.glass.geometry.getIndex();
      if (gidx) tris += gidx.count / 3;
    }
    quads = tris / 2;
    this.stats.quads = quads;
    this.stats.triangles = tris;

    // Тень идёт за игроком: солнце светит на его окрестность, а не на всю карту.
    this.sun.target.position.copy(this.camera.position);
    this.sun.position.copy(this.camera.position).add(new THREE.Vector3(-40, 60, 30));

    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const c of this.chunks.values()) {
      c.opaque.geometry.dispose();
      c.glass.geometry.dispose();
    }
    this.chunks.clear();
    this.shapeChunks.clear();
    this.opaqueMaterial.dispose();
    this.glassMaterial.dispose();
    this.renderer.dispose();
  }
}

function applyMesh(mesh: THREE.Mesh, data: MeshData): void {
  const geom = mesh.geometry as THREE.BufferGeometry;
  geom.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  geom.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geom.computeBoundingSphere();
  mesh.visible = data.quads > 0;
}
