import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

import { getRequestId } from '../logging/request-context.js';

import { DomainError } from './domain-error.js';

/**
 * Упрощённый фильтр DomainError → problem+json без зависимости от PinoLogger.
 *
 * Зачем: e2e и места, где полный AllExceptionsFilter с pino неудобен подключать.
 * Как: DomainError → его httpStatus; HttpException → status; иначе 500.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  /**
   * Перехватывает исключение и пишет problem+json.
   *
   * @param exception - пойманное исключение
   * @param host - HTTP-контекст Nest
   * @returns void
   */
  public catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<{ url?: string }>();
    const requestId = getRequestId();

    if (exception instanceof DomainError) {
      response
        .status(exception.httpStatus)
        .type('application/problem+json')
        .json({
          type: exception.type,
          title: exception.title,
          status: exception.httpStatus,
          detail: exception.detail,
          instance: request.url,
          requestId,
          ...exception.meta,
        });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response
        .status(status)
        .type('application/problem+json')
        .json({
          type: `https://example.com/problems/http-${String(status)}`,
          title: exception.name,
          status,
          detail: exception.message,
          instance: request.url,
          requestId,
        });
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).type('application/problem+json').json({
      type: 'https://example.com/problems/internal-error',
      title: 'Внутренняя ошибка сервера',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'Произошла непредвиденная ошибка',
      instance: request.url,
      requestId,
    });
  }
}
