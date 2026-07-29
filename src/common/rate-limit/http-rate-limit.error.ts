import { DomainError } from '../errors/domain-error.js';

/**
 * Превышен транспортный лимит частоты HTTP-запросов с одного источника.
 *
 * Зачем: отдельный code от `rate-limit-exceeded` (бизнес-лимит на (userId, type)) — клиент по
 * problem.type различает «слишком много уведомлений этого типа» и «слишком много запросов вообще».
 */
export class HttpRateLimitExceededError extends DomainError {
  /**
   * Создаёт ошибку превышения транспортного лимита.
   *
   * @param limit - максимум запросов в окне
   * @param windowMs - длина окна в миллисекундах
   * @param retryAfterMs - через сколько мс можно повторить запрос
   */
  public constructor(limit: number, windowMs: number, retryAfterMs: number) {
    super(
      'too-many-requests',
      429,
      `Разрешено ${String(limit)} запросов за ${String(Math.ceil(windowMs / 1000))} с`,
      { limit, windowMs, retryAfterMs },
    );
  }
}
