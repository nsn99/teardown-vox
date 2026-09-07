/// <reference lib="webworker" />
import { ChunkSlice, meshBuffers, meshSlice } from './chunk-view.js';

/**
 * Воркер меширования.
 *
 * Тела здесь нет намеренно: вся работа — в `meshSlice`, том же коде, что
 * работает в главном потоке, когда воркеров нет. Воркер, у которого своя
 * реализация меширования, — это две геометрии, расходящиеся по мере
 * правок, и швы, которые видно только в одном из двух режимов.
 */

export interface RemeshRequest {
  key: string;
  token: number;
  slice: ChunkSlice;
  aoStrength: number;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<RemeshRequest>) => {
  const { key, token, slice, aoStrength } = e.data;
  const res = meshSlice(slice, aoStrength);
  // Буферы отдаём во владение: копировать десятки килобайт вершин на
  // каждый чанк — это ровно та работа в главном потоке, ради ухода от
  // которой воркер и заведён.
  ctx.postMessage({ key, token, opaque: res.opaque, transparent: res.transparent }, [
    ...meshBuffers(res.opaque),
    ...meshBuffers(res.transparent),
  ]);
};
