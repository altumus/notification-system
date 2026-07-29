import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import type { Response } from 'express';

import { HttpRateLimitExceededError } from './http-rate-limit.error.js';

/**
 * Транспортный лимит частоты HTTP-запросов на IP.
 *
 * Зачем: базовый лимит из задания (10 уведомлений в минуту одного типа) считается в БД по
 * (userId, type) и требует запроса к Postgres — то есть флуд всё равно оплачивается ресурсами.
 * Этот guard режет поток до валидации и до похода в БД, включая анонимные маршруты (/auth/dev-token).
 *
 * Как: наследует ThrottlerGuard (in-memory счётчики на инстанс), но подменяет форму ответа на
 * problem+json с отдельным code `too-many-requests` и заголовками RateLimit-*, как у бизнес-429.
 *
 * Ограничение: счётчики локальны для процесса. При N инстансах эффективный лимит — N × HTTP_RATE_LIMIT;
 * для общего бюджета нужен ThrottlerStorageRedis (см. docs/adr/0008-http-rate-limit.md).
 */
@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  /**
   * Определяет ключ счётчика — клиентский IP.
   *
   * Зачем: до аутентификации userId неизвестен, а защищать нужно именно анонимный флуд.
   * Как: `req.ips[0]` при `trust proxy` (Railway/ingress), иначе `req.ip`; без IP — общее ведро,
   * чтобы отсутствие адреса не превращалось в обход лимита.
   *
   * @param req - объект запроса Express
   * @returns Идентификатор источника запроса
   */
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const forwarded = req['ips'];
    if (Array.isArray(forwarded) && typeof forwarded[0] === 'string' && forwarded[0].length > 0) {
      return Promise.resolve(forwarded[0]);
    }
    const ip = req['ip'];
    return Promise.resolve(typeof ip === 'string' && ip.length > 0 ? ip : 'unknown');
  }

  /**
   * Отдаёт 429 в формате problem+json со стандартными заголовками лимита.
   *
   * Зачем: ThrottlerException возвращает обычный Nest-ответ, а контракт API — RFC 9457.
   * Как: выставляет RateLimit-* / Retry-After и бросает доменную ошибку для глобального фильтра.
   *
   * @param context - контекст выполнения Nest
   * @param detail - параметры сработавшего лимита
   * @returns Никогда не возвращает — всегда бросает исключение
   * @throws {HttpRateLimitExceededError} Всегда
   */
  protected override throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const retryAfterSec = Math.max(1, Math.ceil(detail.timeToBlockExpire));
    const res = context.switchToHttp().getResponse<Response>();
    res.setHeader('RateLimit-Limit', String(detail.limit));
    res.setHeader('RateLimit-Remaining', '0');
    res.setHeader('RateLimit-Reset', String(retryAfterSec));
    res.setHeader('Retry-After', String(retryAfterSec));
    throw new HttpRateLimitExceededError(detail.limit, detail.ttl, retryAfterSec * 1000);
  }
}
