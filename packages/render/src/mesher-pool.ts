import { ChunkSlice, sliceBuffers } from './chunk-view.js';
import { MeshData } from './mesher.js';

/**
 * Пул воркеров-мешеров.
 *
 * Заводится только там, где браузер умеет модульные воркеры. В остальных
 * случаях — в тестах, в старых сборках, в headless без поддержки —
 * возвращается `undefined`, и сцена мешит как мешила, в кадре и по
 * бюджету. Один рабочий путь и один запасной, оба живые: путь, который
 * никогда не исполняется, ломается молча.
 */

export interface RemeshResult {
  key: string;
  token: number;
  opaque: MeshData;
  transparent: MeshData;
}

export class MesherPool {
  private workers: Worker[] = [];
  private next = 0;
  private disposed = false;

  private constructor(
    count: number,
    make: () => Worker,
    private onResult: (r: RemeshResult) => void,
    private onFailure: () => void,
  ) {
    for (let i = 0; i < count; i++) {
      const w = make();
      w.onmessage = (e: MessageEvent<RemeshResult>) => {
        if (!this.disposed) this.onResult(e.data);
      };
      // Воркер, который не загрузился, ошибку даёт уже после конструктора
      // — и без этой строки карта просто не появилась бы, молча. Один
      // отказ хоронит весь пул: сцена вернётся к мешированию в кадре.
      w.onerror = () => {
        if (this.disposed) return;
        this.dispose();
        this.onFailure();
      };
      this.workers.push(w);
    }
  }

  get slots(): number {
    return this.workers.length;
  }

  /**
   * Сколько задач держать в работе одновременно.
   *
   * По две на воркер, а не по одной. Причина в том, что готовый меш
   * принимает главный поток, а он занят кадром: пока он рисует, воркер с
   * пустыми руками просто стоит. Запас в одну задачу закрывает эту дыру
   * целиком — воркер берёт следующий чанк, не дожидаясь, пока у главного
   * потока дойдут руки до предыдущего.
   *
   * Больше двух брать нельзя: всё, что отдано воркеру, отменить уже не
   * получится, и глубокая очередь внутри воркера — это ровно тот случай,
   * когда отмена перестаёт работать. Две задачи — это худшее ожидание
   * длиной в один чанк, то есть миллисекунды.
   */
  get depth(): number {
    return this.workers.length * 2;
  }

  /**
   * Поднять пул, если браузер это позволяет.
   *
   * Воркеров берём на один меньше числа ядер и не больше четырёх. Меньше
   * — потому что главный поток тоже работает: он рисует кадр, и отнимать
   * у него ядро ради меширования бессмысленно. Не больше четырёх —
   * потому что упирается всё в память и в передачу буферов, а не в счёт.
   */
  static create(
    onResult: (r: RemeshResult) => void,
    onFailure: () => void,
  ): MesherPool | undefined {
    if (typeof Worker === 'undefined') return undefined;
    const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 4;
    const count = Math.max(1, Math.min(4, cores - 1));
    try {
      return new MesherPool(
        count,
        () => new Worker(new URL('./remesh.worker.ts', import.meta.url), { type: 'module' }),
        onResult,
        onFailure,
      );
    } catch {
      // Воркер может не подняться из-за политики страницы. Это не повод
      // ронять игру: запасной путь остаётся.
      return undefined;
    }
  }

  /** Отдать чанк на меширование. Круговая раздача, задач не больше мест. */
  mesh(key: string, token: number, slice: ChunkSlice, aoStrength: number): void {
    if (this.disposed || this.workers.length === 0) return;
    const w = this.workers[this.next % this.workers.length];
    this.next++;
    w.postMessage({ key, token, slice, aoStrength }, sliceBuffers(slice) as Transferable[]);
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
