import { Injectable } from '@nestjs/common';

import type { EnvConfig } from './env.schema.js';
import { parseEnv, productionWarnings } from './env.schema.js';

/**
 * Типизированный доступ к конфигурации приложения.
 *
 * Зачем: скрывает process.env и отдаёт уже разобранные значения с корректными типами.
 * Как: парсит env один раз в конструкторе; геттеры не перечитывают окружение.
 */
@Injectable()
export class AppConfigService {
  private readonly config: EnvConfig;

  /**
   * Создаёт сервис конфигурации и валидирует окружение.
   *
   * Зачем: fail-fast при старте DI-контейнера Nest.
   * Как: вызывает parseEnv(process.env).
   */
  public constructor() {
    this.config = parseEnv(process.env);
  }

  /**
   * Возвращает полный снимок конфигурации.
   *
   * Зачем: удобно передавать конфиг в тесты и фабрики провайдеров.
   * Как: отдаёт замороженный по смыслу объект из конструктора (мутации не предполагаются).
   *
   * @returns Полная типизированная конфигурация
   */
  public get raw(): EnvConfig {
    return this.config;
  }

  /**
   * Режим выполнения процесса.
   *
   * @returns development | test | production
   */
  public get nodeEnv(): EnvConfig['NODE_ENV'] {
    return this.config.NODE_ENV;
  }

  /**
   * HTTP-порт API.
   *
   * @returns Порт прослушивания
   */
  public get port(): number {
    return this.config.PORT;
  }

  /**
   * Уровень логирования pino.
   *
   * @returns Уровень лога
   */
  public get logLevel(): EnvConfig['LOG_LEVEL'] {
    return this.config.LOG_LEVEL;
  }

  /**
   * Строка подключения к PostgreSQL.
   *
   * @returns DATABASE_URL
   */
  public get databaseUrl(): string {
    return this.config.DATABASE_URL;
  }

  /**
   * Максимум соединений в пуле pg.
   *
   * @returns Размер пула
   */
  public get dbPoolMax(): number {
    return this.config.DB_POOL_MAX;
  }

  /**
   * Таймаут SQL-запроса в миллисекундах.
   *
   * @returns statement_timeout
   */
  public get dbStatementTimeoutMs(): number {
    return this.config.DB_STATEMENT_TIMEOUT_MS;
  }

  /**
   * Секрет подписи JWT.
   *
   * @returns JWT_SECRET
   */
  public get jwtSecret(): string {
    return this.config.JWT_SECRET;
  }

  /**
   * TTL JWT-токена (строка вида 24h).
   *
   * @returns JWT_TTL
   */
  public get jwtTtl(): string {
    return this.config.JWT_TTL;
  }

  /**
   * Включена ли выдача dev-токенов.
   *
   * @returns true, если эндпоинт /auth/dev-token доступен
   */
  public get authDevTokensEnabled(): boolean {
    return this.config.AUTH_DEV_TOKENS_ENABLED;
  }

  /**
   * Глобальный лимит уведомлений на (user, type) в окне.
   *
   * @returns Максимум принятых уведомлений
   */
  public get notificationsRateLimit(): number {
    return this.config.NOTIFICATIONS_RATE_LIMIT;
  }

  /**
   * Окно rate limit в миллисекундах.
   *
   * @returns Длина окна
   */
  public get notificationsRateWindowMs(): number {
    return this.config.NOTIFICATIONS_RATE_WINDOW_MS;
  }

  /**
   * Окно дедупликации в миллисекундах.
   *
   * @returns Длина окна схлопывания
   */
  public get notificationsDedupWindowMs(): number {
    return this.config.NOTIFICATIONS_DEDUP_WINDOW_MS;
  }

  /**
   * Namespace/path Socket.IO.
   *
   * @returns Путь WS
   */
  public get wsPath(): string {
    return this.config.WS_PATH;
  }

  /**
   * Размер партии backlog при реконнекте.
   *
   * @returns Число элементов в batch
   */
  public get wsBacklogBatchSize(): number {
    return this.config.WS_BACKLOG_BATCH_SIZE;
  }

  /**
   * Максимум страниц backlog за одно подключение.
   *
   * @returns WS_BACKLOG_MAX_PAGES
   */
  public get wsBacklogMaxPages(): number {
    return this.config.WS_BACKLOG_MAX_PAGES;
  }

  /**
   * Интервал Socket.IO ping.
   *
   * @returns WS_PING_INTERVAL_MS
   */
  public get wsPingIntervalMs(): number {
    return this.config.WS_PING_INTERVAL_MS;
  }

  /**
   * Таймаут Socket.IO ping.
   *
   * @returns WS_PING_TIMEOUT_MS
   */
  public get wsPingTimeoutMs(): number {
    return this.config.WS_PING_TIMEOUT_MS;
  }

  /**
   * Максимальный размер HTTP-буфера Engine.IO.
   *
   * @returns WS_MAX_HTTP_BUFFER_SIZE
   */
  public get wsMaxHttpBufferSize(): number {
    return this.config.WS_MAX_HTTP_BUFFER_SIZE;
  }

  /**
   * Лимит одновременных WS-соединений на одного пользователя.
   *
   * @returns WS_MAX_CONNECTIONS_PER_USER
   */
  public get wsMaxConnectionsPerUser(): number {
    return this.config.WS_MAX_CONNECTIONS_PER_USER;
  }

  /**
   * Таймаут ожидания ack на push `notification.created`.
   *
   * @returns WS_ACK_TIMEOUT_MS
   */
  public get wsAckTimeoutMs(): number {
    return this.config.WS_ACK_TIMEOUT_MS;
  }

  /**
   * Интервал sweeper недоставленных уведомлений.
   *
   * @returns Интервал в мс
   */
  public get sweeperIntervalMs(): number {
    return this.config.SWEEPER_INTERVAL_MS;
  }

  /**
   * Минимальный возраст недоставленного, прежде чем sweeper его трогает.
   *
   * @returns SWEEPER_MIN_AGE_MS
   */
  public get sweeperMinAgeMs(): number {
    return this.config.SWEEPER_MIN_AGE_MS;
  }

  /**
   * Включён ли фоновый sweeper недоставленных.
   *
   * @returns SWEEPER_ENABLED
   */
  public get sweeperEnabled(): boolean {
    return this.config.SWEEPER_ENABLED;
  }

  /**
   * Сколько месяцев партиций создавать вперёд.
   *
   * @returns Число месяцев lookahead
   */
  public get partitionLookaheadMonths(): number {
    return this.config.PARTITION_LOOKAHEAD_MONTHS;
  }

  /**
   * Срок хранения партиций в месяцах.
   *
   * @returns RETENTION_MONTHS
   */
  public get retentionMonths(): number {
    return this.config.RETENTION_MONTHS;
  }

  /**
   * Включён ли DROP старых партиций.
   *
   * @returns true, если retention активен
   */
  public get retentionEnabled(): boolean {
    return this.config.RETENTION_ENABLED;
  }

  /**
   * Список CORS origins (через запятую или *).
   *
   * @returns Сырая строка CORS_ORIGINS
   */
  public get corsOrigins(): string {
    return this.config.CORS_ORIGINS;
  }

  /**
   * URL Redis для Socket.IO adapter (опционально).
   *
   * @returns REDIS_URL или undefined
   */
  public get redisUrl(): string | undefined {
    return this.config.REDIS_URL;
  }

  /**
   * Включены ли фоновые cron-задачи (ScheduleModule).
   *
   * @returns true, если CRON_ENABLED
   */
  public get cronEnabled(): boolean {
    return this.config.CRON_ENABLED;
  }

  /**
   * Признак production-режима.
   *
   * @returns true в production
   */
  public get isProduction(): boolean {
    return this.config.NODE_ENV === 'production';
  }

  /**
   * Признак test-режима (Jest).
   *
   * @returns true в test
   */
  public get isTest(): boolean {
    return this.config.NODE_ENV === 'test';
  }

  /**
   * Разбирает CORS_ORIGINS в массив или boolean для Nest CORS.
   *
   * Зачем: `*` нельзя смешивать с credentials; удобнее отдавать готовое значение в main.ts.
   * Как: `*` → true; иначе split по запятой с trim.
   *
   * @returns true (все origins) или список origin-строк
   */
  public getCorsOriginOption(): boolean | string[] {
    if (this.config.CORS_ORIGINS.trim() === '*') {
      return true;
    }
    return this.config.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }

  /**
   * Предупреждения о рискованных production-настройках.
   *
   * Зачем: bootstrap логирует их при старте, чтобы открытый демо-стенд был виден в логах.
   *
   * @returns Список предупреждений (пустой вне production или при строгой конфигурации)
   */
  public getProductionWarnings(): string[] {
    return productionWarnings(this.config);
  }
}
