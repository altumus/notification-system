import { validate as validateUuid, version as uuidVersion, v7 as uuidV7 } from 'uuid';

/**
 * Генерирует UUIDv7 с заданной меткой времени в миллисекундах.
 *
 * Зачем: id и created_at должны происходить из одних и тех же msecs (инвариант §3.1) —
 * иначе `WHERE id = $1 AND created_at = $2` для partition pruning перестанет совпадать.
 * Как: `uuid.v7({ msecs })`; msecs берутся из `clock_timestamp()` БД в транзакции создания.
 *
 * @param msecs - Unix-время в миллисекундах (без микросекунд)
 * @returns Строка UUIDv7
 */
export function newUuidV7(msecs: number): string {
  return uuidV7({ msecs });
}

/**
 * Извлекает Date из UUIDv7 (старшие 48 бит = Unix ms).
 *
 * Зачем: API работает «по id» (`PATCH /notifications/:id/read`), а таблица партиционирована
 * по created_at — без вывода даты из id пришлось бы сканировать все партиции.
 * Как: читает big-endian 48-битный timestamp из первых 6 байт UUID.
 *
 * @param id - строка UUID
 * @returns Date с миллисекундной точностью, совпадающей с msecs генерации
 * @throws {Error} Если id не является валидным UUIDv7
 */
export function uuidV7ToDate(id: string): Date {
  assertUuidV7(id);
  const hex = id.replaceAll('-', '');
  const ms = Number(BigInt(`0x${hex.slice(0, 12)}`));
  return new Date(ms);
}

/**
 * Проверяет, что строка — валидный UUIDv7.
 *
 * Зачем: для не-v7 UUID `uuidV7ToDate` вернул бы мусорный timestamp, и partition pruning
 * молча искал бы не ту партицию (или не нашёл бы строку). Лучше упасть явно.
 * Как: `uuid.validate` + `uuid.version === 7`.
 *
 * @param id - проверяемая строка
 * @returns void
 * @throws {Error} Если формат или версия UUID неверны
 */
export function assertUuidV7(id: string): void {
  if (!validateUuid(id) || uuidVersion(id) !== 7) {
    throw new Error(`Ожидался UUIDv7, получено: ${id}`);
  }
}
