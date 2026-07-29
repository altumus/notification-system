/**
 * Базовая доменная ошибка с HTTP-статусом и машинным кодом.
 *
 * Зачем: единый контракт для фильтра problem+json; внутренние детали не утекают наружу.
 * Как: наследники задают code/httpStatus; meta уходит в расширения Problem Details.
 */
export class DomainError extends Error {
  /**
   * Создаёт доменную ошибку.
   *
   * @param code - машинный код (например rate-limit-exceeded)
   * @param httpStatus - HTTP-статус ответа
   * @param detail - человекочитаемое описание для клиента
   * @param meta - дополнительные поля Problem Details
   */
  public constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    public readonly detail: string,
    public readonly meta: Record<string, unknown> = {},
  ) {
    super(detail);
    this.name = new.target.name;
  }

  /**
   * URI типа проблемы по RFC 9457.
   *
   * @returns URL вида https://example.com/problems/{code}
   */
  public get type(): string {
    return `https://example.com/problems/${this.code}`;
  }

  /**
   * Краткий заголовок проблемы.
   *
   * @returns Title для Problem Details
   */
  public get title(): string {
    return this.detail;
  }
}
