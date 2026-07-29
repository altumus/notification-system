import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RateLimitExceededError } from './domain/errors.js';
import type { Notification } from './domain/notification.entity.js';
import { CreateNotificationDto } from './dto/create-notification.dto.js';
import { GetUnreadQueryDto } from './dto/get-unread-query.dto.js';
import { NotificationResponseDto } from './dto/notification-response.dto.js';
import { NotificationsService } from './notifications.service.js';

/**
 * REST API уведомлений (`/api/v1/notifications`).
 *
 * Зачем: публичный контракт R1 — create / unread / mark read.
 * Как: тонкий слой валидация → сервис → DTO. До коммита 10 владелец читающих
 * операций передаётся заголовком `X-User-Id` (заменится на JWT).
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  /**
   * Создаёт контроллер уведомлений.
   *
   * @param notificationsService - доменный сервис
   */
  public constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * Создаёт уведомление или возвращает схлопнутый дубль.
   *
   * Зачем: R1 create; 201 vs 200 различают «новая сущность» и «deduplicated».
   * Как: сервис create; RateLimitExceededError → 429 + RateLimit-* заголовки.
   *
   * @param body - DTO создания
   * @param _idempotencyKey - зарезервировано (коммит 11)
   * @param res - Express Response для статус-кода и заголовков
   * @returns Тело с status и notification
   */
  @Post()
  @ApiOperation({ summary: 'Создать уведомление' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiResponse({ status: 201, description: 'Создано' })
  @ApiResponse({ status: 200, description: 'Схлопнуто (deduplicated)' })
  @ApiResponse({ status: 422, description: 'Ошибка валидации' })
  @ApiResponse({ status: 429, description: 'Превышен rate limit' })
  public async create(
    @Body() body: CreateNotificationDto,
    @Headers('idempotency-key') _idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 'created' | 'deduplicated'; notification: NotificationResponseDto }> {
    try {
      const result = await this.notificationsService.create({
        userId: body.userId,
        type: body.type,
        payload: body.payload,
      });
      res.status(result.status === 'created' ? HttpStatus.CREATED : HttpStatus.OK);
      return {
        status: result.status,
        notification: toResponseDto(result.notification),
      };
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        applyRateLimitHeaders(res, error);
      }
      throw error;
    }
  }

  /**
   * Список непрочитанных с keyset-пагинацией.
   *
   * @param query - limit и cursor
   * @param userId - временный X-User-Id до JWT (коммит 10)
   * @returns Страница непрочитанных
   */
  @Get('unread')
  @ApiOperation({ summary: 'Список непрочитанных' })
  @ApiHeader({ name: 'X-User-Id', required: true })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiResponse({ status: 422, description: 'Битый cursor' })
  public async listUnread(
    @Query() query: GetUnreadQueryDto,
    @Headers('x-user-id') userId: string,
  ): Promise<{
    items: NotificationResponseDto[];
    nextCursor: string | null;
    unreadCount: number;
    unreadCountExact: boolean;
  }> {
    const result = await this.notificationsService.listUnread(userId, query.limit, query.cursor);
    return {
      items: result.items.map(toResponseDto),
      nextCursor: result.nextCursor,
      unreadCount: result.unreadCount,
      unreadCountExact: result.unreadCountExact,
    };
  }

  /**
   * Счётчик непрочитанных для бейджа.
   *
   * @param userId - временный X-User-Id
   * @returns count и exact
   */
  @Get('unread/count')
  @ApiOperation({ summary: 'Счётчик непрочитанных' })
  @ApiHeader({ name: 'X-User-Id', required: true })
  @ApiResponse({ status: 200, description: 'OK' })
  public async countUnread(
    @Headers('x-user-id') userId: string,
  ): Promise<{ count: number; exact: boolean }> {
    return this.notificationsService.countUnread(userId);
  }

  /**
   * Помечает уведомление прочитанным.
   *
   * @param id - UUIDv7 уведомления
   * @param userId - временный X-User-Id
   * @returns Обновлённое уведомление
   */
  @Patch(':id/read')
  @ApiOperation({ summary: 'Пометить прочитанным' })
  @ApiHeader({ name: 'X-User-Id', required: true })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiResponse({ status: 404, description: 'Не найдено' })
  public async markAsRead(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Headers('x-user-id') userId: string,
  ): Promise<{ notification: NotificationResponseDto }> {
    const notification = await this.notificationsService.markAsRead(userId, id);
    return { notification: toResponseDto(notification) };
  }

  /**
   * Помечает все непрочитанные прочитанными.
   *
   * @param userId - временный X-User-Id
   * @returns Число обновлённых строк
   */
  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Прочитать все' })
  @ApiHeader({ name: 'X-User-Id', required: true })
  @ApiResponse({ status: 200, description: 'OK' })
  public async markAllAsRead(@Headers('x-user-id') userId: string): Promise<{ updated: number }> {
    return this.notificationsService.markAllAsRead(userId);
  }
}

/**
 * Маппит доменную сущность в response DTO с ISO-датами.
 *
 * @param notification - доменное уведомление
 * @returns DTO для JSON
 */
function toResponseDto(notification: Notification): NotificationResponseDto {
  return {
    id: notification.id,
    userId: notification.userId,
    type: notification.type,
    payload: notification.payload,
    occurrences: notification.occurrences,
    createdAt: notification.createdAt.toISOString(),
    lastSeenAt: notification.lastSeenAt.toISOString(),
    readAt: notification.readAt?.toISOString() ?? null,
    deliveredAt: notification.deliveredAt?.toISOString() ?? null,
  };
}

/**
 * Выставляет заголовки RateLimit-* и Retry-After для 429.
 *
 * @param res - Express Response
 * @param error - ошибка лимита
 * @returns void
 */
function applyRateLimitHeaders(res: Response, error: RateLimitExceededError): void {
  const limit = Number(error.meta['limit']);
  const retryAfterMs = Number(error.meta['retryAfterMs']);
  const windowMs = Number(error.meta['windowMs']);
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', '0');
  res.setHeader('RateLimit-Reset', String(Math.ceil(retryAfterMs / 1000)));
  res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  res.setHeader('X-RateLimit-Window-Ms', String(windowMs));
}
