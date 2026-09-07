/**
 * Очередь ремеша.
 *
 * Задача очереди не «раздать работу», а решить три вопроса, каждый из
 * которых игрок замечает глазами.
 *
 * Первый — порядок. Игрок смотрит на дыру, которую только что пробил, и
 * ждать, пока перестроится дальний угол карты, ему незачем. Поэтому
 * ближние чанки идут первыми, и порядок пересчитывается на ходу: камера
 * едет, и «ближний» через секунду — уже другой чанк.
 *
 * Второй — повторные заявки. Стена, по которой бьют очередью, помечается
 * грязной десятки раз подряд. Задача на чанк должна быть ровно одна, иначе
 * воркеры будут строить историю разрушения вместо её результата.
 *
 * Третий — отмена. Отменить уже отданную воркеру работу нельзя: у
 * страницы без cross-origin isolation нет разделяемой памяти, а значит и
 * способа шепнуть воркеру «брось». Поэтому очередь держит запас у себя, а
 * воркеру отдаёт ровно по одной задаче на свободное место. Тогда
 * отменённое либо не уходило вовсе — и не стоило ничего, даже нарезки
 * куска, — либо ждало не дольше одного чанка. Свалить всё в postMessage
 * было бы проще и означало бы, что отмена не работает вовсе.
 */

interface Waiting<T> {
  key: string;
  priority: number;
  /** Нагрузка строится в момент отправки: отменённое не платит за нарезку. */
  build: () => T;
}

interface Running {
  token: number;
  /** Нужен ли ещё результат. Отменённое доедет и будет выброшено. */
  wanted: boolean;
}

export interface RemeshQueueOptions<T> {
  /** Сколько задач одновременно в работе — обычно по числу воркеров. */
  slots: number;
  /** Отправить задачу в работу. */
  send: (key: string, token: number, payload: T) => void;
}

export class RemeshQueue<T> {
  private waiting = new Map<string, Waiting<T>>();
  private running = new Map<string, Running>();
  private seq = 0;
  private busy = 0;

  constructor(private opts: RemeshQueueOptions<T>) {}

  get pending(): number {
    return this.waiting.size;
  }

  get active(): number {
    return this.busy;
  }

  /** Всего чанков, которые ещё не построены: и ждущие, и в работе. */
  get outstanding(): number {
    let n = this.waiting.size;
    for (const r of this.running.values()) if (r.wanted) n++;
    return n;
  }

  /**
   * Поставить чанк в очередь. Повторная заявка на тот же чанк заменяет
   * прежнюю, а уже отданную воркеру — обесценивает: её результат построен
   * по устаревшим вокселям, и принимать его нельзя.
   */
  submit(key: string, priority: number, build: () => T): void {
    const run = this.running.get(key);
    if (run) run.wanted = false;
    this.waiting.set(key, { key, priority, build });
  }

  /** Обновить приоритет ждущего чанка. Камера двигается — порядок меняется. */
  setPriority(key: string, priority: number): void {
    const w = this.waiting.get(key);
    if (w) w.priority = priority;
  }

  /** Отменить: из очереди — бесследно, из работы — с отказом от результата. */
  cancel(key: string): void {
    this.waiting.delete(key);
    const run = this.running.get(key);
    if (run) run.wanted = false;
  }

  /** Забыть всё: смена уровня, выгрузка формы. */
  clear(): void {
    this.waiting.clear();
    for (const r of this.running.values()) r.wanted = false;
  }

  /** Раздать работу по свободным местам. */
  pump(): void {
    while (this.busy < this.opts.slots && this.waiting.size > 0) {
      const next = this.takeNearest();
      if (!next) return;
      const token = ++this.seq;
      this.running.set(next.key, { token, wanted: true });
      this.busy++;
      // Нарезка — здесь и только здесь: то, что отменили в очереди, не
      // стоило даже копирования вокселей.
      this.opts.send(next.key, token, next.build());
    }
  }

  /**
   * Результат от воркера. Возвращает, нужен ли он ещё.
   * Место освобождается в любом случае: воркер уже отработал.
   */
  accept(key: string, token: number): boolean {
    const run = this.running.get(key);
    if (!run || run.token !== token) {
      // Чужой или дважды пришедший ответ места не занимал и не освобождает.
      return false;
    }
    this.running.delete(key);
    this.busy--;
    return run.wanted;
  }

  /**
   * Ближайший из ждущих.
   *
   * Линейный поиск, а не куча: приоритеты пересчитываются каждый кадр
   * целиком, и куча пришлось бы перестраивать целиком же. Ждущих —
   * десятки, в самом злом случае сотни; полтысячи сравнений на кадр
   * дешевле одного меширования в тысячу раз.
   */
  private takeNearest(): Waiting<T> | undefined {
    let best: Waiting<T> | undefined;
    for (const w of this.waiting.values()) {
      if (!best || w.priority < best.priority) best = w;
    }
    if (best) this.waiting.delete(best.key);
    return best;
  }
}
