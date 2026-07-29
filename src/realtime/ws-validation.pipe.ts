import { type PipeTransform, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import type { ZodType } from 'zod';

/**
 * Pipe Zod-валидации входящих WS payload.
 *
 * Зачем: HTTP ValidationPipe не применяется к ack-callback Socket.IO так же стабильно.
 * Как: safeParse → при ошибке WsException с `{ error: { code, message } }`.
 */
@Injectable()
export class WsValidationPipe implements PipeTransform {
  /**
   * Создаёт pipe для конкретной Zod-схемы.
   *
   * @param schema - схема payload
   */
  public constructor(private readonly schema: ZodType) {}

  /**
   * Валидирует значение и возвращает разобранные данные.
   *
   * @param value - сырой MessageBody
   * @returns Типизированный payload
   * @throws {WsException} Если валидация не прошла
   */
  public transform(value: unknown): unknown {
    const parsed = this.schema.safeParse(value ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues.map((issue) => issue.message).join('; ');
      throw new WsException({
        error: { code: 'validation_error', message },
      });
    }
    return parsed.data;
  }
}

/**
 * Фабрика pipe для конкретной схемы (удобно в `@UsePipes`).
 *
 * @param schema - Zod-схема
 * @returns Экземпляр WsValidationPipe
 */
export function createWsValidationPipe(schema: ZodType): WsValidationPipe {
  return new WsValidationPipe(schema);
}
