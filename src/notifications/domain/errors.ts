import { DomainError } from '../../common/errors/domain-error.js';

/**
 * Превышен лимит уведомлений на (userId, type) в окне.
 *
 * Зачем: R5 — не больше N уведомлений в минуту одного типа; клиент получает 429 и Retry-After.
 */
export class RateLimitExceededError extends DomainError {
  /**
   * Создаёт ошибку превышения rate limit.
   *
   * @param type - тип уведомления
   * @param limit - максимум принятых уведомлений в окне
   * @param windowMs - длина окна в миллисекундах
   * @param retryAfterMs - через сколько мс можно повторить запрос
   */
  public constructor(type: string, limit: number, windowMs: number, retryAfterMs: number) {
    super(
      'rate-limit-exceeded',
      429,
      `Для типа ${type} разрешено ${String(limit)} уведомлений в минуту`,
      { limit, windowMs, retryAfterMs, notificationType: type },
    );
  }
}

/**
 * Уведомление не найдено или принадлежит другому пользователю.
 *
 * Зачем: одинаковый 404 для «нет» и «чужое» не даёт перебирать чужие id (анти-IDOR).
 */
export class NotificationNotFoundError extends DomainError {
  /**
   * Создаёт ошибку отсутствия уведомления.
   *
   * @param id - идентификатор уведомления
   */
  public constructor(id: string) {
    super('notification-not-found', 404, `Уведомление ${id} не найдено`, { id });
  }
}

/**
 * Битый или устаревший курсор keyset-пагинации.
 *
 * Зачем: битый cursor должен давать 422, а не 500 — это ошибка клиента.
 */
export class InvalidCursorError extends DomainError {
  /**
   * Создаёт ошибку невалидного курсора.
   *
   * @param detail - пояснение для клиента
   */
  public constructor(detail = 'Некорректный курсор пагинации') {
    super('invalid-cursor', 422, detail);
  }
}
