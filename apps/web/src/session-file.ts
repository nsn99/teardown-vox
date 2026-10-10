import type { SessionSave } from '@tvox/game';

/** Preserve typed paint, material maps, attachments and infinite fuses in JSON. */
export function encodeSession(save: SessionSave): string {
  validateSession(save);
  return JSON.stringify({ format: 'tvox-session', version: 1, save }, (_key, value: unknown) => {
    if (value instanceof Uint32Array) return { $tvox: 'u32', values: [...value] };
    if (value instanceof Map) return { $tvox: 'map', values: [...value] };
    if (value instanceof Set) return { $tvox: 'set', values: [...value] };
    if (value === Infinity) return { $tvox: 'infinity' };
    if (value === -Infinity) return { $tvox: '-infinity' };
    return value;
  });
}

export function decodeSession(raw: string): SessionSave {
  if (raw.length > 100 * 1024 * 1024) throw new Error('Файл сохранения слишком большой');
  const data = JSON.parse(raw, (_key, value) => {
    if (!value || typeof value !== 'object' || !value.$tvox) return value;
    if (value.$tvox === 'infinity') return Infinity;
    if (value.$tvox === '-infinity') return -Infinity;
    if (!Array.isArray(value.values)) throw new Error('Повреждённые данные сохранения');
    if (value.$tvox === 'u32') {
      if (!value.values.every((v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff)) throw new Error('Некорректный цвет');
      return new Uint32Array(value.values);
    }
    if (value.$tvox === 'map') return new Map(value.values);
    if (value.$tvox === 'set') return new Set(value.values);
    throw new Error('Неизвестный тип данных сохранения');
  });
  if (!data || data.format !== 'tvox-session' || data.version !== 1) throw new Error('Это не файл сессии игры');
  validateSession(data.save);
  return data.save;
}

export function validateSession(value: unknown): asserts value is SessionSave {
  const s = value as SessionSave | undefined;
  if (!s || s.version !== 1 || typeof s.levelId !== 'string' || typeof s.fingerprint !== 'string' ||
      !Number.isFinite(s.savedAt) || typeof s.sandbox !== 'boolean' || !Array.isArray(s.bodies) ||
      !s.character?.position || !s.mission || !s.inventory || !Array.isArray(s.vehicles) ||
      !Array.isArray(s.cranes) || !Array.isArray(s.gates) || !Array.isArray(s.charges) ||
      !Array.isArray(s.chasers) || !s.fire || !s.smoke || !s.heist || !s.triggers ||
      !Array.isArray(s.destruction) || !Number.isFinite(s.time)) throw new Error('Сохранение несовместимо или повреждено');
  for (const body of s.bodies) {
    if (!Array.isArray(body.shapes) || !body.transform || !Number.isInteger(body.base)) throw new Error('Повреждены тела сохранения');
    for (const shape of body.shapes) {
      if (!Number.isInteger(shape.base) || !(shape.paint instanceof Uint32Array) || !Array.isArray(shape.damage) ||
          !Array.isArray(shape.attachments) || !Array.isArray(shape.anchors)) throw new Error('Повреждена геометрия сохранения');
    }
  }
}
