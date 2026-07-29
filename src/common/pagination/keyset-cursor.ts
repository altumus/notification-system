import { InvalidCursorError } from '../../notifications/domain/errors.js';

const CURSOR_VERSION = 1 as const;

/**
 * Полезная нагрузка keyset-курсора для списка непрочитанных.
 */
export interface KeysetCursorPayload {
  createdAt: Date;
  id: string;
}

interface CursorWireFormat {
  v: typeof CURSOR_VERSION;
  createdAt: string;
  id: string;
}

/**
 * Кодирует позицию keyset-пагинации в opaque-строку.
 *
 * Зачем: клиент не должен собирать курсор сам; OFFSET на больших объёмах деградирует и
 * пропускает строки при вставках между запросами страниц.
 * Как: JSON `{v, createdAt, id}` → base64url.
 *
 * @param payload - createdAt и id последней отданной строки
 * @returns Строка курсора для query `cursor=`
 */
export function encodeKeysetCursor(payload: KeysetCursorPayload): string {
  const wire: CursorWireFormat = {
    v: CURSOR_VERSION,
    createdAt: payload.createdAt.toISOString(),
    id: payload.id,
  };
  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
}

/**
 * Декодирует и валидирует keyset-курсор.
 *
 * Зачем: битый cursor → 422 (InvalidCursorError), а не 500.
 * Как: base64url → JSON → проверка версии и полей.
 *
 * @param cursor - строка из query
 * @returns Разобранный payload
 * @throws {InvalidCursorError} Если формат или содержимое невалидны
 */
export function decodeKeysetCursor(cursor: string): KeysetCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new InvalidCursorError();
  }

  if (!isCursorWireFormat(parsed)) {
    throw new InvalidCursorError();
  }

  const createdAt = new Date(parsed.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new InvalidCursorError('Некорректная дата в курсоре');
  }

  return { createdAt, id: parsed.id };
}

/**
 * Type guard для wire-формата курсора.
 *
 * @param value - разобранный JSON
 * @returns true, если структура соответствует CursorWireFormat
 */
function isCursorWireFormat(value: unknown): value is CursorWireFormat {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record['v'] === CURSOR_VERSION &&
    typeof record['createdAt'] === 'string' &&
    typeof record['id'] === 'string' &&
    record['id'].length > 0
  );
}
