import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedActor } from '../auth/token-verifier.js';

import { RateLimitExceededError } from './domain/errors.js';
import type { Notification } from './domain/notification.entity.js';
import { CreateNotificationDto } from './dto/create-notification.dto.js';
import { GetUnreadQueryDto } from './dto/get-unread-query.dto.js';
import { NotificationResponseDto } from './dto/notification-response.dto.js';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor.js';
import { NotificationsService } from './notifications.service.js';

/**
 * REST API уведомлений (`/api/v1/notifications`).
 *
 * Зачем: публичный контракт R1 — create / unread / mark read.
 * Как: тонкий слой валидация → сервис → DTO; userId читающих операций — из JWT.
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
   * Зачем: R1 create; роль `service` может писать любому userId, роль `user` — только себе.
   * Как: сервис create; RateLimitExceededError → 429 + RateLimit-* заголовки.
   *
   * @param body - DTO создания
   * @param actor - текущий JWT-актор
   * @param res - Express Response для статус-кода и заголовков
   * @returns Тело с status и notification
   */
  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Создать уведомление' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Транспортная идемпотентность (не путать с дедупом). Повтор с тем же ключом и телом → тот же ответ + Idempotent-Replay: true; другой body → 409; параллельный повтор → 409 + Retry-After: 1',
  })
  @ApiResponse({ status: 201, description: 'Создано' })
  @ApiResponse({ status: 200, description: 'Схлопнуто (deduplicated)' })
  @ApiResponse({ status: 403, description: 'userId не совпадает с токеном роли user' })
  @ApiResponse({ status: 409, description: 'Конфликт Idempotency-Key' })
  @ApiResponse({ status: 422, description: 'Ошибка валидации' })
  @ApiResponse({ status: 429, description: 'Превышен rate limit' })
  public async create(
    @Body() body: CreateNotificationDto,
    @CurrentUser() actor: AuthenticatedActor,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 'created' | 'deduplicated'; notification: NotificationResponseDto }> {
    if (actor.role === 'user' && body.userId !== actor.userId) {
      throw new ForbiddenException('Роль user может создавать уведомления только себе');
    }
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
   * @param actor - JWT-актор (получатель)
   * @returns Страница непрочитанных
   */
  @Get('unread')
  @ApiOperation({ summary: 'Список непрочитанных' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiResponse({ status: 422, description: 'Битый cursor' })
  public async listUnread(
    @Query() query: GetUnreadQueryDto,
    @CurrentUser() actor: AuthenticatedActor,
  ): Promise<{
    items: NotificationResponseDto[];
    nextCursor: string | null;
    unreadCount: number;
    unreadCountExact: boolean;
  }> {
    const result = await this.notificationsService.listUnread(
      actor.userId,
      query.limit,
      query.cursor,
    );
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
   * @param actor - JWT-актор
   * @returns count и exact
   */
  @Get('unread/count')
  @ApiOperation({ summary: 'Счётчик непрочитанных' })
  @ApiResponse({ status: 200, description: 'OK' })
  public async countUnread(
    @CurrentUser() actor: AuthenticatedActor,
  ): Promise<{ count: number; exact: boolean }> {
    return this.notificationsService.countUnread(actor.userId);
  }

  /**
   * Помечает уведомление прочитанным.
   *
   * @param id - UUIDv7 уведомления
   * @param actor - JWT-актор
   * @returns Обновлённое уведомление
   */
  @Patch(':id/read')
  @ApiOperation({ summary: 'Пометить прочитанным' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiResponse({ status: 404, description: 'Не найдено' })
  public async markAsRead(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() actor: AuthenticatedActor,
  ): Promise<{ notification: NotificationResponseDto }> {
    const notification = await this.notificationsService.markAsRead(actor.userId, id);
    return { notification: toResponseDto(notification) };
  }

  /**
   * Помечает все непрочитанные прочитанными.
   *
   * @param actor - JWT-актор
   * @returns Число обновлённых строк
   */
  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Прочитать все' })
  @ApiResponse({ status: 200, description: 'OK' })
  public async markAllAsRead(
    @CurrentUser() actor: AuthenticatedActor,
  ): Promise<{ updated: number }> {
    return this.notificationsService.markAllAsRead(actor.userId);
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
