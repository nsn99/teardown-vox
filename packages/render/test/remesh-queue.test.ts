import { describe, expect, it } from 'vitest';
import { RemeshQueue } from '@tvox/render';

/**
 * Очередь ремеша.
 *
 * Приёмка issue звучит тремя пунктами: ближние чанки раньше дальних,
 * отменённые задачи не тратят время воркера, ремеш не блокирует кадр.
 * Первые два проверяются здесь напрямую, третий — дымовым прогоном в
 * браузере: в узле нет ни кадра, ни воркеров.
 */

/** Очередь с журналом отправок и ручным «воркером». */
function bench(slots: number) {
  const sent: { key: string; token: number; payload: string }[] = [];
  let built = 0;
  const q = new RemeshQueue<string>({
    slots,
    send: (key, token, payload) => sent.push({ key, token, payload }),
  });
  const put = (key: string, priority: number) =>
    q.submit(key, priority, () => {
      built++;
      return `груз:${key}`;
    });
  /** Ответить на отправку номер i так, как ответил бы воркер. */
  const answer = (i: number) => q.accept(sent[i].key, sent[i].token);
  return { q, sent, put, answer, builds: () => built };
}

describe('очередь ремеша', () => {
  it('ближние чанки уходят в работу раньше дальних', () => {
    const b = bench(2);
    b.put('далеко', 900);
    b.put('рядом', 4);
    b.put('средне', 100);
    b.q.pump();

    expect(b.sent.map((s) => s.key)).toEqual(['рядом', 'средне']);
    b.answer(0);
    b.q.pump();
    expect(b.sent.map((s) => s.key)).toEqual(['рядом', 'средне', 'далеко']);
  });

  it('камера поехала — порядок пересчитался', () => {
    const b = bench(1);
    b.put('а', 10);
    b.put('б', 20);
    // Игрок развернулся: то, что было дальним, стало ближним.
    b.q.setPriority('б', 1);
    b.q.pump();
    expect(b.sent[0].key).toBe('б');
  });

  it('в работе не больше мест, сколько бы ни заявили', () => {
    const b = bench(3);
    for (let i = 0; i < 40; i++) b.put(`ч${i}`, i);
    b.q.pump();
    expect(b.sent.length).toBe(3);
    expect(b.q.active).toBe(3);
    expect(b.q.pending).toBe(37);
    // И это не потеря работы: непостроенных по-прежнему сорок.
    expect(b.q.outstanding).toBe(40);
  });

  it('повторная заявка на тот же чанк не плодит задач', () => {
    const b = bench(2);
    b.put('стена', 5);
    b.put('стена', 5);
    b.put('стена', 5);
    b.q.pump();
    expect(b.sent.length).toBe(1);
    expect(b.q.outstanding).toBe(1);
  });

  it('ответ по устаревшей заявке выбрасывается', () => {
    const b = bench(2);
    b.put('стена', 5);
    b.q.pump();
    // Пока чанк мешился, по стене ударили ещё раз.
    b.put('стена', 5);
    expect(b.answer(0)).toBe(false);
    // Место освободилось, и новая заявка ушла в работу.
    b.q.pump();
    expect(b.sent.length).toBe(2);
    expect(b.answer(1)).toBe(true);
    expect(b.q.outstanding).toBe(0);
  });

  it('дважды пришедший ответ не освобождает лишнего места', () => {
    const b = bench(1);
    b.put('а', 1);
    b.put('б', 2);
    b.q.pump();
    expect(b.answer(0)).toBe(true);
    expect(b.answer(0)).toBe(false);
    b.q.pump();
    // Мест по-прежнему одно: второй ответ не создал свободного.
    expect(b.sent.length).toBe(2);
    expect(b.q.active).toBe(1);
  });

  it('отменённая из очереди задача не стоит даже нарезки', () => {
    const b = bench(1);
    b.put('занял', 0);
    b.put('отменим', 5);
    b.q.pump();
    expect(b.builds()).toBe(1);

    b.q.cancel('отменим');
    b.answer(0);
    b.q.pump();
    // Отправок так и одна, и груз для отменённой не собирался.
    expect(b.sent.length).toBe(1);
    expect(b.builds()).toBe(1);
    expect(b.q.outstanding).toBe(0);
  });

  it('отменённая в работе задача доедет, но результат не примут', () => {
    const b = bench(1);
    b.put('снесли', 3);
    b.q.pump();
    b.q.cancel('снесли');
    expect(b.answer(0)).toBe(false);
    expect(b.q.outstanding).toBe(0);
    expect(b.q.active).toBe(0);
  });

  it('отмена никогда не ждёт дольше одной задачи на место', () => {
    // Смысл в том, что запас держит очередь, а не воркер: сколько бы ни
    // накопилось заявок, отменить можно всё, кроме уже отданного, — а
    // отдано ровно по одной на место.
    const b = bench(2);
    for (let i = 0; i < 50; i++) b.put(`ч${i}`, i);
    b.q.pump();
    for (let i = 0; i < 50; i++) b.q.cancel(`ч${i}`);
    expect(b.sent.length).toBe(2);
    expect(b.q.pending).toBe(0);
    expect(b.q.outstanding).toBe(0);
    expect(b.builds()).toBe(2);
  });

  it('сброс снимает и очередь, и ожидаемые ответы', () => {
    const b = bench(2);
    b.put('а', 1);
    b.put('б', 2);
    b.put('в', 3);
    b.q.pump();
    b.q.clear();
    expect(b.q.pending).toBe(0);
    expect(b.answer(0)).toBe(false);
    expect(b.answer(1)).toBe(false);
    b.q.pump();
    expect(b.sent.length).toBe(2);
  });

  it('чужой ответ не ломает счёт мест', () => {
    const b = bench(1);
    b.put('а', 1);
    b.q.pump();
    expect(b.q.accept('никогда-не-было', 999)).toBe(false);
    expect(b.q.active).toBe(1);
    expect(b.answer(0)).toBe(true);
    expect(b.q.active).toBe(0);
  });

  it('очередь разбирается до конца и ничего не теряет', () => {
    const b = bench(3);
    const keys = Array.from({ length: 25 }, (_, i) => `ч${i}`);
    // Приоритеты вразнобой — порядок должен решать он, а не порядок заявок.
    keys.forEach((k, i) => b.put(k, ((i * 7) % 25) + 1));

    const done: string[] = [];
    let answered = 0;
    for (let guard = 0; guard < 200 && b.q.outstanding > 0; guard++) {
      b.q.pump();
      while (answered < b.sent.length) {
        const s = b.sent[answered++];
        if (b.q.accept(s.key, s.token)) done.push(s.key);
      }
    }
    expect(done.sort()).toEqual(keys.sort());
    expect(b.q.outstanding).toBe(0);
  });
});
