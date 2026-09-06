import { LevelSource, levelFromDoc, readVox, voxSandboxDoc } from '@tvox/game';

/**
 * Загрузка карты перетаскиванием.
 *
 * Бросил `.json` — играешь свою карту. Бросил `.vox` из MagicaVoxel —
 * играешь свою модель на готовой площадке. Пересборка приложения при этом
 * не нужна, и в этом весь смысл: правка уровня не должна упираться в
 * инструменты разработчика.
 */

export interface LevelDropHandlers {
  onLevel(level: LevelSource, fileName: string): void;
  onError(message: string): void;
  /** Файл потащили над окном — можно подсветить, что его ждут. */
  onHover?(over: boolean): void;
}

export function enableLevelDrop(target: HTMLElement | Window, handlers: LevelDropHandlers): () => void {
  const el = target as HTMLElement;

  const over = (e: Event): void => {
    const drag = e as DragEvent;
    drag.preventDefault();
    if (drag.dataTransfer) drag.dataTransfer.dropEffect = 'copy';
    handlers.onHover?.(true);
  };
  const leave = (): void => handlers.onHover?.(false);

  const drop = (e: Event): void => {
    const drag = e as DragEvent;
    drag.preventDefault();
    handlers.onHover?.(false);
    const file = drag.dataTransfer?.files?.[0];
    if (!file) return;
    void levelFromFile(file)
      .then((next) => handlers.onLevel(next, file.name))
      .catch((err: unknown) =>
        handlers.onError(err instanceof Error ? err.message : String(err)),
      );
  };

  el.addEventListener('dragover', over);
  el.addEventListener('dragleave', leave);
  el.addEventListener('drop', drop);
  return () => {
    el.removeEventListener('dragover', over);
    el.removeEventListener('dragleave', leave);
    el.removeEventListener('drop', drop);
  };
}

/** Файл в уровень. Формат берём по расширению, а не по содержимому. */
export async function levelFromFile(file: File): Promise<LevelSource> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.vox')) {
    const vox = readVox(await file.arrayBuffer());
    return levelFromDoc(voxSandboxDoc(vox, 0, { name: file.name.replace(/\.vox$/i, '') }));
  }
  if (name.endsWith('.json')) {
    return levelFromDoc(await file.text());
  }
  throw new Error(`Не знаю, что делать с «${file.name}»: жду .json или .vox`);
}
