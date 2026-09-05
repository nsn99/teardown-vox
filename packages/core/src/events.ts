/** Крошечная типизированная шина событий. Никаких зависимостей, sync-доставка. */
export class EventBus<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(fn as (payload: never) => void);
    return () => this.off(event, fn);
  }

  once<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    const off = this.on(event, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): void {
    this.handlers.get(event)?.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // Копия: обработчик может отписаться прямо во время доставки.
    for (const fn of [...set]) (fn as (p: Events[K]) => void)(payload);
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  clear(): void {
    this.handlers.clear();
  }
}
