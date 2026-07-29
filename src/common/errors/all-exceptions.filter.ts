import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { getRequestId } from '../logging/request-context.js';

import { DomainError } from './domain-error.js';

/**
 * Тело ответа в формате RFC 9457 Problem Details.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  requestId?: string;
  [key: string]: unknown;
}

/**
 * Извлекает человекочитаемый detail из тела HttpException.
 *
 * Зачем: Nest кладёт validation-ошибки в message как string | string[].
 * Как: строка используется как есть; у объекта читается поле message.
 *
 * @param body - результат HttpException.getResponse()
 * @param fallback - сообщение исключения по умолчанию
 * @returns Текст для поля detail
 */
function extractHttpExceptionDetail(body: string | object, fallback: string): string {
  if (typeof body === 'string') {
    return body;
  }
  if (!('message' in body)) {
    return fallback;
  }
  const message: unknown = body.message;
  if (typeof message === 'string') {
    return message;
  }
  if (Array.isArray(message)) {
    return message.map(String).join('; ');
  }
  return fallback;
}

/**
 * Глобальный фильтр исключений → application/problem+json.
 *
 * Зачем: единый контракт ошибок для API; 5xx логируются со стеком, наружу — без утечки деталей.
 * Как: DomainError → его status/meta; HttpException → status/message; остальное → 500.
 */
@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  /**
   * Создаёт фильтр с логгером.
   *
   * @param logger - структурный логгер pino
   */
  public constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  /**
   * Перехватывает любое исключение и формирует Problem Details.
   *
   * @param exception - пойманное исключение
   * @param host - контекст Nest (HTTP)
   * @returns void (пишет ответ в Express Response)
   */
  public catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ url?: string }>();
    const requestId = getRequestId();

    const problem = this.toProblemDetails(exception, request.url, requestId);

    if (problem.status >= 500) {
      this.logger.error({ err: exception, requestId, problem }, 'Необработанная ошибка сервера');
    } else {
      this.logger.warn({ requestId, problem }, 'Ошибка запроса');
    }

    response.status(problem.status).type('application/problem+json').json(problem);
  }

  /**
   * Преобразует исключение в Problem Details.
   *
   * @param exception - исходное исключение
   * @param instance - путь запроса
   * @param requestId - корреляционный id
   * @returns Объект Problem Details
   */
  private toProblemDetails(
    exception: unknown,
    instance: string | undefined,
    requestId: string | undefined,
  ): ProblemDetails {
    const base: ProblemDetails = {
      type: 'https://example.com/problems/internal-error',
      title: 'Внутренняя ошибка сервера',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'Произошла непредвиденная ошибка',
    };
    if (instance !== undefined) {
      base.instance = instance;
    }
    if (requestId !== undefined) {
      base.requestId = requestId;
    }

    if (exception instanceof DomainError) {
      return {
        ...base,
        type: exception.type,
        title: exception.title,
        status: exception.httpStatus,
        detail: exception.detail,
        ...exception.meta,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const detail = extractHttpExceptionDetail(body, exception.message);

      return {
        ...base,
        type: `https://example.com/problems/http-${String(status)}`,
        title: exception.name,
        status,
        detail,
      };
    }

    return base;
  }
}
