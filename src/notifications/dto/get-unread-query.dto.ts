import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Query-параметры списка непрочитанных уведомлений.
 *
 * Зачем: keyset-пагинация без OFFSET; лимит ограничен 1..100.
 */
export class GetUnreadQueryDto {
  /**
   * Размер страницы.
   */
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public limit = 20;

  /**
   * Курсор предыдущей страницы (opaque base64url).
   */
  @ApiPropertyOptional({ description: 'Keyset-курсор из nextCursor предыдущего ответа' })
  @IsOptional()
  @IsString()
  public cursor?: string;
}
