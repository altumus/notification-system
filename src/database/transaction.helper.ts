import type { Kysely, Transaction } from 'kysely';

import type { Database } from './schema.types.js';

/**
 * Максимум попыток выполнения транзакции при ретраибельных конфликтах.
 */
const MAX_ATTEMPTS = 3;

/**
 * База экспоненциальной задержки между попытками (мс): 50, 100, 200.
 */
const BASE_DELAY_MS = 50;

/**
 * Коды SQLSTATE, при которых повтор всей транзакции безопасен и осмыслен:
 * `40001` — serialization_failure (конфликт сериализуемых транзакций),
 * `40P01` — deadlock_detected (взаимная блокировка, одна из транзакций отменяется сервером).
 */
const RETRYABLE_SQLSTATE_CODES = new Set(['40001', '40P01']);

/**
 * Проверяет, что ошибка — это ретраибельный конфликт Postgres по коду SQLSTATE.
 *
 * Зачем: отличить «стоит повторить» (гонка транзакций) от «повторять бессмысленно»
 * (нарушение ограничения, синтаксическая ошибка и т.п. — в этих случаях повтор даст тот же результат).
 * Как: `pg` кладёт SQLSTATE в поле `code` объекта ошибки; Kysely не оборачивает эту ошибку
 * (см. `postgres-driver.ts` в исходниках Kysely — стек лишь расширяется), поэтому `code` доступен
 * напрямую.
 *
 * @param error - перехваченная ошибка транзакции
 * @returns true, если код ошибки входит в список ретраибельных
 */
function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const { code } = error;
  return typeof code === 'string' && RETRYABLE_SQLSTATE_CODES.has(code);
}

/**
 * Приостанавливает выполнение на заданное число миллисекунд.
 *
 * @param ms - длительность паузы в миллисекундах
 * @returns Promise, завершающийся по истечении паузы
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Выполняет функцию в транзакции Kysely с ретраем при сериализационных конфликтах и дедлоках.
 *
 * Зачем: под нагрузкой конкурентные транзакции над одними и теми же строками (advisory-lock
 * из раздела 3.4 плана, счётчики rate limit) периодически конфликтуют на уровне Postgres —
 * это ожидаемое поведение, а не баг, и клиент не должен получать 5xx на ровном месте.
 * Как: `BEGIN`/`COMMIT`/`ROLLBACK` берёт на себя `db.transaction().execute(fn)`; при кодах
 * `40001`/`40P01` вся функция `fn` вызывается заново (максимум 3 попытки, экспоненциальная
 * задержка 50/100/200 мс). Повтор безопасен только если `fn` идемпотентна по построению —
 * это гарантирует вызывающий код (например, коммит 07: advisory-lock + поиск дедуп-якоря перед
 * вставкой делают повтор эквивалентным первому вызову).
 *
 * @param db - подключение Kysely, на котором открывается транзакция
 * @param fn - тело транзакции; получает `Transaction<Database>` для запросов
 * @returns Результат `fn` после успешного коммита
 * @throws {Error} Исходную ошибку транзакции, если она не ретраибельна или попытки исчерпаны
 */
export async function withTransaction<T>(
  db: Kysely<Database>,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await db.transaction().execute(fn);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryableTransactionError(error)) {
        throw error;
      }
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}
