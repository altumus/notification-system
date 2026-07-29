import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Контекст запроса, доступный через AsyncLocalStorage.
 */
export interface RequestContextStore {
  requestId: string;
}

/**
 * Хранилище requestId для корреляции HTTP → WS → SQL.
 *
 * Зачем: структурные логи и problem+json должны нести один requestId без явной прокидки.
 * Как: middleware кладёт значение в ALS; сервисы читают getRequestId().
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContextStore>();

/**
 * Возвращает requestId текущего асинхронного контекста.
 *
 * Зачем: единый способ получить корреляционный id из любого слоя.
 * Как: читает ALS; если контекста нет — возвращает undefined.
 *
 * @returns requestId или undefined вне HTTP/WS-контекста
 */
export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}

/**
 * Выполняет функцию внутри ALS-контекста с заданным requestId.
 *
 * Зачем: WS-хендлеры и фоновые задачи тоже нуждаются в корреляции.
 * Как: requestContextStorage.run({ requestId }, fn).
 *
 * @param requestId - идентификатор запроса/соединения
 * @param fn - функция, выполняемая в контексте
 * @returns Результат fn
 */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestContextStorage.run({ requestId }, fn);
}
