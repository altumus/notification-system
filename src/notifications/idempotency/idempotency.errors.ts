import { DomainError } from '../../common/errors/domain-error.js';

/**
 * Конфликт Idempotency-Key: тот же ключ с другим телом или запрос ещё выполняется.
 *
 * Зачем: клиент должен отличить «replay» от «ключ занят другим запросом».
 * Как: HTTP 409 + опциональный Retry-After в meta для in-flight.
 */
export class IdempotencyConflictError extends DomainError {
  /**
   * Создаёт ошибку конфликта идемпотентности.
   *
   * @param detail - человекочитаемое описание
   * @param meta - дополнительные поля (retryAfterSec и т.п.)
   */
  public constructor(detail: string, meta: Record<string, unknown> = {}) {
    super('idempotency-conflict', 409, detail, meta);
  }
}

/**
 * Некорректный заголовок Idempotency-Key.
 *
 * Зачем: отклонить слишком длинные/мусорные ключи до обращения к БД.
 */
export class IdempotencyKeyInvalidError extends DomainError {
  /**
   * Создаёт ошибку валидации ключа.
   *
   * @param detail - описание проблемы
   */
  public constructor(detail: string) {
    super('idempotency-key-invalid', 400, detail);
  }
}
