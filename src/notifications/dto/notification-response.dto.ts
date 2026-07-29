import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Тело уведомления в REST/Swagger (зеркало доменной сущности).
 */
export class NotificationResponseDto {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ format: 'uuid' })
  public userId!: string;

  @ApiProperty({ example: 'order.status_changed' })
  public type!: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  public payload!: Record<string, unknown>;

  @ApiProperty({ example: 1 })
  public occurrences!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  public createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  public lastSeenAt!: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  public readAt!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  public deliveredAt!: string | null;
}
