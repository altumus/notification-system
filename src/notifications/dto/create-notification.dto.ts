import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsObject,
  IsUUID,
  Matches,
  MaxLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  type ValidationArguments,
} from 'class-validator';

/** Максимальный размер JSON payload в байтах UTF-8. */
export const NOTIFICATION_PAYLOAD_MAX_BYTES = 8 * 1024;

/**
 * Валидатор размера JSON payload.
 *
 * Зачем: ограничение только body-limit на уровне HTTP недостаточно — нужен явный 422
 * с problem+json, а не обрыв соединения на слишком большом теле.
 */
@ValidatorConstraint({ name: 'payloadSize', async: false })
export class PayloadSizeConstraint implements ValidatorConstraintInterface {
  /**
   * Проверяет, что сериализованный payload не превышает лимит.
   *
   * @param value - значение поля payload
   * @param _args - аргументы валидации class-validator
   * @returns true, если размер допустим
   */
  public validate(value: unknown, _args: ValidationArguments): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
    return size <= NOTIFICATION_PAYLOAD_MAX_BYTES;
  }

  /**
   * Сообщение об ошибке размера payload.
   *
   * @returns Текст для class-validator
   */
  public defaultMessage(): string {
    return `payload превышает ${String(NOTIFICATION_PAYLOAD_MAX_BYTES)} байт`;
  }
}

/**
 * HTTP DTO создания уведомления.
 *
 * Зачем: валидация на границе API + примеры для Swagger (R1).
 */
export class CreateNotificationDto {
  /**
   * Идентификатор получателя.
   */
  @ApiProperty({ format: 'uuid', example: '018f0e3a-8c2b-7b10-8e2a-0a1b2c3d4e5f' })
  @IsUUID()
  public userId!: string;

  /**
   * Тип уведомления (доменный код).
   */
  @ApiProperty({ example: 'order.status_changed', pattern: '^[a-z][a-z0-9_.]{1,63}$' })
  @Matches(/^[a-z][a-z0-9_.]{1,63}$/)
  @MaxLength(64)
  public type!: string;

  /**
   * Произвольный JSON-объект с данными уведомления.
   */
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { orderId: 42, status: 'shipped' },
  })
  @IsObject()
  @Validate(PayloadSizeConstraint)
  public payload: Record<string, unknown> = {};
}
