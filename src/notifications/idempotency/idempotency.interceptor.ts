import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { from, lastValueFrom, type Observable } from 'rxjs';

import type { AuthenticatedActor } from '../../auth/token-verifier.js';
import { DomainError } from '../../common/errors/domain-error.js';

import { IdempotencyConflictError } from './idempotency.errors.js';
import { IdempotencyService } from './idempotency.service.js';

/**
 * Интерцептор Idempotency-Key для POST /notifications.
 *
 * Зачем: ретрай с тем же ключом возвращает сохранённый ответ без повторного create.
 * Как: claim → next.handle → complete; replay с заголовком Idempotent-Replay: true;
 * pending/другой hash → 409 (Retry-After: 1 при in-flight).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  /**
   * Создаёт интерцептор.
   *
   * @param idempotency - сервис claim/complete
   */
  public constructor(private readonly idempotency: IdempotencyService) {}

  /**
   * Оборачивает handler create идемпотентной семантикой при наличии заголовка.
   *
   * @param context - HTTP-контекст
   * @param next - следующий handler
   * @returns Observable тела ответа
   */
  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{
      headers: { 'idempotency-key'?: string };
      body: Record<string, unknown>;
      user?: AuthenticatedActor;
    }>();
    const response = http.getResponse<Response>();
    const rawKey = request.headers['idempotency-key'];
    const actor = request.user;

    if (rawKey === undefined || rawKey.length === 0 || actor === undefined) {
      return next.handle();
    }

    return from(this.executeWithIdempotency(rawKey, actor, request.body, response, next));
  }

  /**
   * Выполняет claim → handler → complete (или replay).
   *
   * @param rawKey - сырой заголовок
   * @param actor - JWT-актор
   * @param body - тело запроса
   * @param response - Express Response
   * @param next - CallHandler
   * @returns Тело ответа
   */
  private async executeWithIdempotency(
    rawKey: string,
    actor: AuthenticatedActor,
    body: Record<string, unknown>,
    response: Response,
    next: CallHandler,
  ): Promise<unknown> {
    const { key, requestHash } = this.idempotency.parseKeyAndHash(rawKey, {
      userId: body['userId'],
      type: body['type'],
      payload: body['payload'],
    });

    let begin;
    try {
      begin = await this.idempotency.begin(key, actor.userId, requestHash);
    } catch (error) {
      if (
        error instanceof IdempotencyConflictError &&
        typeof error.meta['retryAfterSec'] === 'number'
      ) {
        response.setHeader('Retry-After', String(error.meta['retryAfterSec']));
      }
      throw error;
    }

    if (begin.kind === 'replay') {
      response.status(begin.status);
      response.setHeader('Idempotent-Replay', 'true');
      return begin.body;
    }

    try {
      const result: unknown = await lastValueFrom(next.handle());
      const status = response.statusCode;
      await this.idempotency.complete(key, status, asJsonObject(result));
      return result;
    } catch (error) {
      if (error instanceof DomainError) {
        await this.idempotency.complete(key, error.httpStatus, domainErrorToBody(error));
        throw error;
      }
      if (error instanceof HttpException) {
        const status = error.getStatus();
        await this.idempotency.complete(key, status, httpExceptionToBody(error));
        throw error;
      }
      await this.idempotency.release(key);
      throw error;
    }
  }
}

/**
 * Приводит успешный результат handler к JSON-объекту для хранения.
 *
 * @param value - результат controller
 * @returns Объект для jsonb
 */
function asJsonObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

/**
 * Сериализует DomainError в форму, близкую к problem+json.
 *
 * @param error - доменная ошибка
 * @returns Тело для replay
 */
function domainErrorToBody(error: DomainError): Record<string, unknown> {
  return {
    type: error.type,
    title: error.title,
    status: error.httpStatus,
    detail: error.detail,
    ...error.meta,
  };
}

/**
 * Сериализует HttpException для replay.
 *
 * @param error - HTTP-исключение Nest
 * @returns Тело для replay
 */
function httpExceptionToBody(error: HttpException): Record<string, unknown> {
  const status = error.getStatus();
  const body = error.getResponse();
  if (typeof body === 'string') {
    return {
      type: `https://example.com/problems/http-${String(status)}`,
      title: error.name,
      status,
      detail: body,
    };
  }
  return {
    type: `https://example.com/problems/http-${String(status)}`,
    title: error.name,
    status,
    detail: error.message,
    ...(body as Record<string, unknown>),
  };
}
