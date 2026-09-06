import * as THREE from 'three';
import {
  Body,
  CHUNK_SIZE,
  SKY_MAX,
  SkyLightField,
  VoxelRegion,
  VoxelShape,
  VoxelWorld,
  regionIsEmpty,
} from '@tvox/core';
import { MeshData, meshShape } from './mesher.js';

/** Ключ чанка по координатам сетки. Сдвиг — чтобы -1 не схлопывался с 1. */
const key3 = (x: number, y: number, z: number): number =>
  (((x + 1) * 4096 + (y + 1)) * 4096) + (z + 1);

export type Quality = 'low' | 'medium' | 'high';

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  quality?: Quality;
  /** Ребро чанка в вокселях. Меньше — точнее ремеш, больше — меньше вызовов отрисовки. */
  chunkSize?: number;
  /** Сколько чанков перестраиваем за кадр. */
  remeshBudget?: number;
  /**
   * Потолок времени на ремеш в кадре, мс. Чанк чанку рознь: пустой
   * строится мгновенно, а угол склада — это шесть проходов по 32³
   * клеткам. Считать бюджет в штуках — значит иногда потратить кадр
   * целиком, поэтому решает время.
   */
  remeshMs?: number;
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

export type Daylight = 'day' | 'dusk' | 'night';

/** Источник света уровня: прожектор на кране, лампа над воротами. */
export interface LevelLight {
  kind: 'point' | 'spot';
  position: { x: number; y: number; z: number };
  /** Куда смотрит прожектор. Для точечной лампы не нужно. */
  target?: { x: number; y: number; z: number };
  /** Цвет в формате #rrggbb. */
  color: string;
  intensity: number;
  /** Дальность, м. */
  range: number;
  /** Раствор конуса, рад. Только для прожектора. */
  angle?: number;
  /**
   * Прожектор отбрасывает тень.
   *
   * Без этого он светит сквозь стены: лампа во дворе спокойно освещает
   * пол внутри склада, и никакая честная модель освещённости этого не
   * исправит — прямой свет теней не знает. Тень стоит карты глубины,
   * поэтому включается точечно, для тех ламп, где это видно.
   */
  shadow?: boolean;
}

/**
 * Время суток.
 *
 * Три пресета, а не плавный цикл: миссия длится минуты, солнце за это
 * время никуда не уйдёт, а вот выбор «день или ночь» меняет всю карту —
 * ночью читаются прожекторы, окна и огонь, днём — материалы и тени.
 */
const DAYLIGHT: Record<Daylight, {
  sky: number;
  fogNear: number;
  sun: number;
  sunColor: number;
  hemiSky: number;
  hemiGround: number;
  hemi: number;
  /** Насколько тёмными остаются места, куда не доходит небо. */
  skyFloor: number;
  exposure: number;
}> = {
  // Суммарная освещённость подобрана так, чтобы бетон оставался бетоном.
  // Сложить солнце, небо и подсветку «на глаз» — верный способ получить
  // белую заливку вместо материала: альбедо бетона 0.59, и всё, что даёт
  // в сумме больше полутора, выжигает его в бумагу.
  day: {
    sky: 0x9dc4e8,
    fogNear: 90,
    sun: 1.85,
    sunColor: 0xfff2dc,
    hemiSky: 0xbcd6f0,
    hemiGround: 0x6b6355,
    hemi: 0.86,
    skyFloor: 0.3,
    exposure: 0.92,
  },
  dusk: {
    sky: 0x1b2a3a,
    fogNear: 60,
    sun: 1.15,
    sunColor: 0xffdcb4,
    hemiSky: 0x88a8cc,
    hemiGround: 0x2e2a26,
    hemi: 0.7,
    skyFloor: 0.22,
    exposure: 0.95,
  },
  night: {
    sky: 0x070c14,
    fogNear: 32,
    sun: 0.22,
    sunColor: 0x9fb6f0,
    hemiSky: 0x1e2c40,
    hemiGround: 0x0d0c10,
    hemi: 0.3,
    skyFloor: 0.1,
    exposure: 1.0,
  },
};

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
  private shapeHolders = new Map<number, THREE.Group>();
  /** Ближайший ремеш идёт целиком, без бюджета: это загрузка уровня. */
  private priming = true;
  private opaqueMaterial: THREE.MeshStandardMaterial;
  private glassMaterial: THREE.MeshStandardMaterial;
  private chunkSize: number;
  private remeshBudget: number;
  private remeshMs: number;
  private aoStrength: number;
  private seenShapes = new Set<number>();
  /**
   * Небесный свет по вокселям. Карта теней знает, куда падает солнце, но
   * не знает, что внутри склада темно: без этого поля разрушенная стена
   * ничего не меняет в освещении зала.
   */
  private sky = new SkyLightField();
  private hemi: THREE.HemisphereLight;
  private levelLights: THREE.Object3D[] = [];
  /** Лампы с неподвижной тенью: обновляются по перестройке геометрии. */
  private staticShadows: THREE.SpotLight[] = [];
  private lastShadowRefresh = 0;
  private quality: Quality;
  private shadowSize: number;
  private skyFloor = { value: 0.24 };
  private voxelUniform = { value: 0.1 };
  private daylight: Daylight = 'dusk';

  /** Метрики последнего кадра — для перф-регрессии. */
  stats = { chunks: 0, remeshed: 0, dirty: 0, quads: 0, triangles: 0 };

  constructor(opts: RendererOptions) {
    const quality = QUALITY[opts.quality ?? 'medium'];
    this.chunkSize = opts.chunkSize ?? 32;
    this.remeshBudget = opts.remeshBudget ?? 6;
    this.remeshMs = opts.remeshMs ?? 4;
    this.aoStrength = quality.ao;
    this.shadowSize = quality.shadowMap;
    this.quality = opts.quality ?? 'medium';

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

    this.hemi = new THREE.HemisphereLight(0xa8c4e0, 0x3a352e, 0.95);
    this.scene.add(this.hemi);

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


    this.opaqueMaterial = this.voxelMaterial(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.82,
        metalness: 0.06,
        flatShading: true,
      }),
    );
    this.glassMaterial = this.voxelMaterial(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.08,
        metalness: 0.15,
        transparent: true,
        opacity: 0.4,
        flatShading: true,
        side: THREE.DoubleSide,
      }),
    );
    this.setDaylight('dusk');
  }

  /**
   * Заливающего света в сцене намеренно нет.
   *
   * Ненаправленная лампа «с воды» удобно вытягивала теневую сторону
   * склада — и ровно так же светила сквозь стены внутрь, где неба нет.
   * Купол справляется не хуже, а гасится небесным полем честно.
   */

  /**
   * Свойства материала приходят из вершин, а не из объекта THREE.
   *
   * Материалов у нас восемнадцать, чанков — сотни: делать по материалу на
   * каждый — это тысячи вызовов отрисовки вместо сотен. Поэтому
   * металличность, шероховатость и свечение едут в атрибутах, а
   * стандартный шейдер правится в трёх местах, чтобы их прочитать.
   * Там же гасится рассеянный свет по небесному полю — от этого внутри
   * склада темно, а в пробитую дыру бьёт свет.
   */
  private voxelMaterial(base: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    base.onBeforeCompile = (shader) => {
      shader.uniforms.uSkyFloor = this.skyFloor;
      shader.uniforms.uVoxel = this.voxelUniform;

      // Правка чужого шейдера — это ставка на то, что имена кусков не
      // поменялись. Ставку надо проверять: если THREE переименует хоть
      // один include, лучше отрисовать сцену обычным материалом, чем
      // собрать шейдер с дырой и получить чёрный экран у игрока.
      const missing: string[] = [];
      const patch = (src: string, token: string, text: string): string => {
        if (!src.includes(token)) {
          missing.push(token);
          return src;
        }
        return src.replace(token, text);
      };

      const vertex = patch(
        patch(
          shader.vertexShader,
          '#include <common>',
          `#include <common>
           attribute vec3 aProps;
           attribute float aSky;
           varying vec3 vProps;
           varying float vSky;
           varying vec3 vVoxelPos;`,
        ),
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vProps = aProps;
         vSky = aSky;
         vVoxelPos = transformed;`,
      );

      let fragment = patch(
        shader.fragmentShader,
        '#include <common>',
        `#include <common>
         uniform float uSkyFloor;
         uniform float uVoxel;
         varying vec3 vProps;
         varying float vSky;
         varying vec3 vVoxelPos;
         float tvoxHash( vec3 p ) {
           return fract( sin( dot( p, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
         }`,
      );
      fragment = patch(
        fragment,
        '#include <color_fragment>',
        `#include <color_fragment>
         // Зерно по вокселям, а не по грани. Жадная склейка отдаёт
         // набережную одним квадом на сорок метров, и без этого она
         // выглядит листом бумаги, а не бетоном. Считать в пикселе
         // дешевле, чем ломать склейку ради разноцветных вершин.
         float grain = tvoxHash( floor( vVoxelPos / uVoxel + 0.5 ) );
         diffuseColor.rgb *= mix( 0.90, 1.07, grain );`,
      );
      fragment = patch(
        fragment,
        '#include <roughnessmap_fragment>',
        'float roughnessFactor = clamp( vProps.y, 0.035, 1.0 );',
      );
      fragment = patch(
        fragment,
        '#include <metalnessmap_fragment>',
        'float metalnessFactor = clamp( vProps.x, 0.0, 1.0 );',
      );
      fragment = patch(
        fragment,
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         totalEmissiveRadiance += diffuseColor.rgb * vProps.z * 2.2;`,
      );
      fragment = patch(
        fragment,
        '#include <lights_fragment_begin>',
        `#include <lights_fragment_begin>
         irradiance *= mix( uSkyFloor, 1.0, vSky );`,
      );

      if (missing.length > 0) {
        console.warn(
          `Шейдер THREE изменился, воксельные правки отключены: ${missing.join(', ')}`,
        );
        return;
      }
      shader.vertexShader = vertex;
      shader.fragmentShader = fragment;
    };

    // Ключ кэша программ обязан отличаться от стандартного: иначе THREE
    // подсунет сюда уже собранный шейдер без наших атрибутов.
    base.customProgramCacheKey = () => 'tvox-voxel';
    return base;
  }

  get time(): Daylight {
    return this.daylight;
  }

  /** Переключить время суток. Работает на лету, без пересборки сцены. */
  setDaylight(time: Daylight): void {
    const p = DAYLIGHT[time];
    this.daylight = time;
    this.scene.background = new THREE.Color(p.sky);
    this.scene.fog = new THREE.Fog(p.sky, p.fogNear, this.camera.far);
    this.sun.intensity = p.sun;
    this.sun.color = new THREE.Color(p.sunColor);
    this.hemi.color = new THREE.Color(p.hemiSky);
    this.hemi.groundColor = new THREE.Color(p.hemiGround);
    this.hemi.intensity = p.hemi;
    this.skyFloor.value = p.skyFloor;
    this.renderer.toneMappingExposure = p.exposure;
  }

  /**
   * Свет уровня: прожекторы на кране, лампы над воротами.
   * Приходит из документа карты — ставить их в коде значило бы, что своя
   * карта играется в темноте.
   */
  setLevelLights(lights: readonly LevelLight[] = []): void {
    for (const l of this.levelLights) {
      this.scene.remove(l);
      const lit = l as THREE.Light;
      lit.dispose?.();
    }
    this.levelLights = [];
    this.staticShadows = [];

    for (const def of lights) {
      const color = new THREE.Color(def.color);
      if (def.kind === 'spot') {
        const spot = new THREE.SpotLight(color, def.intensity, def.range, def.angle ?? 0.6, 0.45, 1.4);
        spot.position.set(def.position.x, def.position.y, def.position.z);
        const t = def.target ?? { x: def.position.x, y: 0, z: def.position.z };
        spot.target.position.set(t.x, t.y, t.z);
        if (def.shadow && this.shadowSize > 0) {
          spot.castShadow = true;
          spot.shadow.mapSize.set(1024, 1024);
          spot.shadow.camera.near = 1;
          spot.shadow.camera.far = def.range;
          spot.shadow.bias = -0.0012;
          spot.shadow.normalBias = 0.06;
          // Лампа неподвижна: её карта теней пересчитывается не каждый
          // кадр, а когда в мире что-то перестроилось.
          spot.shadow.autoUpdate = false;
          spot.shadow.needsUpdate = true;
          this.staticShadows.push(spot);
        }
        this.scene.add(spot, spot.target);
        this.levelLights.push(spot, spot.target);
      } else {
        const point = new THREE.PointLight(color, def.intensity, def.range, 1.6);
        point.position.set(def.position.x, def.position.y, def.position.z);
        this.scene.add(point);
        this.levelLights.push(point);
      }
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  setCamera(
    position: { x: number; y: number; z: number },
    yaw: number,
    pitch: number,
    roll = 0,
  ): void {
    this.camera.position.set(position.x, position.y, position.z);
    this.camera.rotation.set(pitch, yaw, roll, 'YXZ');
  }

  /**
   * Атмосфера вокруг камеры: вода и дым.
   *
   * И то и другое — один и тот же приём: подменить туман и цвет фона.
   * Под водой картинка синеет и садится по дальности, в дыму — сереет.
   * Дёшево, обратимо и читается мгновенно, а главное — не требует ни
   * одного дополнительного прохода отрисовки.
   */
  setAtmosphere(state: { underwater: boolean; smoke: number }): void {
    const p = DAYLIGHT[this.daylight];
    const smoke = clamp01(state.smoke);
    const fog = this.scene.fog as THREE.Fog;

    if (state.underwater) {
      const color = new THREE.Color(0x0d3a4a);
      this.scene.background = color;
      fog.color = color;
      fog.near = 0.4;
      fog.far = 14;
      this.renderer.toneMappingExposure = p.exposure * 0.8;
      return;
    }

    // Дым садится в туман: чем гуще завеса, тем ближе подступает серая
    // стена. Дальность видимости падает обратно плотности, а не линейно:
    // вдвое гуще — вдвое ближе. Линейная смесь от трёхсот метров почти
    // ничего не меняла бы до самой сплошной завесы.
    const smokeColor = new THREE.Color(0x8b8f94);
    const base = new THREE.Color(p.sky);
    this.scene.background = base.clone().lerp(smokeColor, Math.min(1, smoke * 1.4));
    fog.color = (this.scene.background as THREE.Color).clone();
    const far = smoke < 0.02 ? this.camera.far : Math.min(this.camera.far, 7 / smoke);
    fog.far = far;
    fog.near = Math.min(p.fogNear, far * 0.12);
    this.renderer.toneMappingExposure = p.exposure * lerp(1, 0.8, smoke);
  }

  /** Качество на лету: без пересоздания сцены и без перезагрузки. */
  setQuality(quality: Quality): void {
    const q = QUALITY[quality];
    this.quality = quality;
    this.aoStrength = q.ao;
    this.shadowSize = q.shadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadowMap > 0;
    this.sun.castShadow = q.shadowMap > 0;
    if (q.shadowMap > 0) this.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    for (const l of this.staticShadows) {
      l.castShadow = q.shadowMap > 0;
      l.shadow.needsUpdate = true;
    }
    // Затенение в углах запечено в вершинах, поэтому смена качества
    // требует пересборки мешей — но не пересборки сцены.
    for (const c of this.chunks.values()) c.dirty = true;
    this.renderer.shadowMap.needsUpdate = true;
  }

  get currentQuality(): Quality {
    return this.quality;
  }

  /**
   * Следующий ремеш пройдёт целиком, без бюджета за кадр.
   * Вызывается при загрузке уровня: лучше один долгий кадр на загрузке,
   * чем карта, проявляющаяся кусками у игрока на глазах.
   */
  prime(): void {
    this.priming = true;
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
        this.syncShapeTransform(shape);
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
    this.shapeHolders.set(shape.id, holder);

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

  /**
   * Пересчёт небесного света по всем изменениям формы разом.
   *
   * Именно разом: чанков, задетых одним взрывом, бывает два десятка, а
   * свет всё равно считается полосой с запасом — двадцать пересчётов
   * одного и того же стоили бы дороже самого взрыва.
   */
  private refreshSky(shape: VoxelShape): VoxelRegion | null {
    if (shape.dirtyMeshChunks.size === 0) return null;
    let region: VoxelRegion | null = null;
    for (const chunk of shape.dirtyMeshChunks) {
      const b = shape.chunkBounds(chunk);
      region = region
        ? {
            x0: Math.min(region.x0, b.x0),
            y0: Math.min(region.y0, b.y0),
            z0: Math.min(region.z0, b.z0),
            x1: Math.max(region.x1, b.x1),
            y1: Math.max(region.y1, b.y1),
            z1: Math.max(region.z1, b.z1),
          }
        : b;
    }
    if (!region) return null;
    this.sky.rebuild(shape, region);

    // Свет меняется дальше, чем геометрия: дыра в крыше освещает пол под
    // собой и стены вокруг. Эти чанки геометрически чистые, но их меш
    // хранит вчерашний свет, поэтому перестроить надо и их.
    return {
      x0: Math.max(0, region.x0 - SKY_MAX),
      y0: 0,
      z0: Math.max(0, region.z0 - SKY_MAX),
      x1: Math.min(shape.sx, region.x1 + SKY_MAX),
      y1: Math.min(shape.sy, region.y1 + SKY_MAX),
      z1: Math.min(shape.sz, region.z1 + SKY_MAX),
    };
  }

  /**
   * Трансформ формы внутри тела обновляется каждый кадр, а не один раз при
   * создании: формы бывают подвижными внутри своего тела — винт вертолёта
   * крутится, а фюзеляж нет.
   */
  private syncShapeTransform(shape: VoxelShape): void {
    const holder = this.shapeHolders.get(shape.id);
    if (!holder) return;
    const t = shape.transform;
    holder.position.set(t.position.x, t.position.y, t.position.z);
    holder.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
  }

  private markDirty(shape: VoxelShape): void {
    const list = this.shapeChunks.get(shape.id);
    if (!list) return;
    const litRegion = this.refreshSky(shape);

    // Список грязных чанков формы годится напрямую, только если сетки
    // совпадают. Они совпадают по умолчанию (32 и там, и там), но размер
    // чанка рендера настраиваемый — на другом падаем в грубый AABB.
    if (this.chunkSize === CHUNK_SIZE && shape.dirtyMeshChunks.size > 0) {
      const wanted = new Set<number>();
      for (const chunk of shape.dirtyMeshChunks) {
        const cx = chunk % shape.chunksX;
        const t = (chunk - cx) / shape.chunksX;
        const cz = t % shape.chunksZ;
        const cy = (t - cz) / shape.chunksZ;
        // Соседи по граням: шов на границе чанка зависит от вокселя за ней.
        wanted.add(key3(cx, cy, cz));
        wanted.add(key3(cx - 1, cy, cz));
        wanted.add(key3(cx + 1, cy, cz));
        wanted.add(key3(cx, cy - 1, cz));
        wanted.add(key3(cx, cy + 1, cz));
        wanted.add(key3(cx, cy, cz - 1));
        wanted.add(key3(cx, cy, cz + 1));
      }
      const cs = this.chunkSize;
      for (const c of list) {
        if (wanted.has(key3(c.cx, c.cy, c.cz))) c.dirty = true;
        else if (litRegion && touches(litRegion, c, cs)) c.dirty = true;
      }
      shape.clearMeshDirty();
      return;
    }

    const region = shape.dirtyMesh;
    if (regionIsEmpty(region)) return;
    const cs = this.chunkSize;
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
      this.shapeHolders.get(shapeId)?.removeFromParent();
      this.shapeHolders.delete(shapeId);
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
    this.stats.dirty = dirty.length;
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

    // Первая сборка идёт без бюджета: карта обязана появиться целиком, а
    // не проявляться чанк за чанком минуту после старта. Бюджет — про
    // разрушение в кадре, а не про загрузку уровня.
    const budget = this.priming ? dirty.length : Math.min(this.remeshBudget, dirty.length);
    const until = this.priming ? Infinity : performance.now() + this.remeshMs;
    let done = 0;
    for (let i = 0; i < budget; i++) {
      this.rebuild(dirty[i]);
      done++;
      // Ближний чанк всегда строим хотя бы один: иначе дыра, в которую
      // игрок смотрит, могла бы не появиться совсем.
      if (performance.now() > until) break;
    }
    this.priming = false;
    this.stats.remeshed = done;
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
    const common = {
      region,
      originAtRegion: true,
      aoStrength: this.aoStrength,
      sky: this.sky.of(entry.shape),
    };
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

    // Неподвижные лампы пересчитывают тень только когда мир изменился —
    // и не чаще раза в секунду. Во время долгого обрушения
    // ремеш идёт каждый кадр, и обновлять по нему карты теней значит
    // рисовать сцену лишний раз на каждую лампу.
    if (this.stats.remeshed > 0 && this.staticShadows.length > 0) {
      const now = performance.now();
      if (now - this.lastShadowRefresh > 900) {
        this.lastShadowRefresh = now;
        for (const l of this.staticShadows) l.shadow.needsUpdate = true;
      }
    }

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

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Задевает ли область освещения чанк. */
function touches(r: VoxelRegion, c: { cx: number; cy: number; cz: number }, cs: number): boolean {
  return (
    c.cx * cs < r.x1 &&
    (c.cx + 1) * cs > r.x0 &&
    c.cy * cs < r.y1 &&
    (c.cy + 1) * cs > r.y0 &&
    c.cz * cs < r.z1 &&
    (c.cz + 1) * cs > r.z0
  );
}

function applyMesh(mesh: THREE.Mesh, data: MeshData): void {
  const geom = mesh.geometry as THREE.BufferGeometry;
  geom.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  geom.setAttribute('aProps', new THREE.BufferAttribute(data.props, 3));
  geom.setAttribute('aSky', new THREE.BufferAttribute(data.light, 1));
  geom.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geom.computeBoundingSphere();
  mesh.visible = data.quads > 0;
}
