import { type ArgumentsHost, Catch, Logger } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';

import { DomainError } from '../common/errors/domain-error.js';

/**
 * Фильтр WS-исключений: доменные ошибки в ack, без разрыва соединения.
 *
 * Зачем: клиент получает `{ error: { code, message } }` и может показать UI, а не reconnect.
 * Как: DomainError/WsException → ack или emit `error`; неожиданные — лог + generic.
 */
@Catch()
export class WsExceptionFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger(WsExceptionFilter.name);

  /**
   * Перехватывает исключение в WS-контексте.
   *
   * @param exception - пойманное исключение
   * @param host - контекст Nest
   * @returns void
   */
  public override catch(exception: unknown, host: ArgumentsHost): void {
    const client = host
      .switchToWs()
      .getClient<{ emit: (event: string, payload: unknown) => void }>();
    const ack = host.getArgByIndex<((payload: unknown) => void) | undefined>(2);
    const payload = this.toErrorPayload(exception);

    if (typeof ack === 'function') {
      ack(payload);
      return;
    }

    client.emit('error', payload);

    if (!(exception instanceof DomainError) && !(exception instanceof WsException)) {
      this.logger.error({ err: exception }, 'Неожиданная ошибка WebSocket');
    }
  }

  /**
   * Нормализует исключение в контракт `{ error: { code, message } }`.
   *
   * @param exception - исходное исключение
   * @returns Тело для ack/emit
   */
  private toErrorPayload(exception: unknown): { error: { code: string; message: string } } {
    if (exception instanceof DomainError) {
      return { error: { code: exception.code, message: exception.detail } };
    }
    if (exception instanceof WsException) {
      const raw = exception.getError();
      if (typeof raw === 'object' && 'error' in raw) {
        const nested: unknown = Reflect.get(raw, 'error');
        if (
          typeof nested === 'object' &&
          nested !== null &&
          'code' in nested &&
          'message' in nested
        ) {
          return {
            error: {
              code: String(Reflect.get(nested, 'code')),
              message: String(Reflect.get(nested, 'message')),
            },
          };
        }
      }
      return {
        error: {
          code: 'ws_error',
          message: typeof raw === 'string' ? raw : exception.message,
        },
      };
    }
    return { error: { code: 'internal_error', message: 'Внутренняя ошибка' } };
  }
}
