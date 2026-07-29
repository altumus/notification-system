import { z } from 'zod';

/**
 * Дефолтный секрет для локальной разработки.
 *
 * Значение публично (лежит в репозитории), поэтому в production запрещено:
 * `assertProductionSafe` не даст приложению стартовать с ним.
 */
export const DEV_JWT_SECRET = 'dev-only-jwt-secret-change-me';

/** Минимальная длина JWT_SECRET в production (256 бит для HS256). */
export const PRODUCTION_MIN_JWT_SECRET_LENGTH = 32;

/**
 * Zod-схема всех переменных окружения приложения.
 *
 * Зачем: fail-fast на старте с человекочитаемым списком проблем вместо падений в рантайме.
 * Как: дефолты безопасны для локальной разработки; в production дополнительно работает
 * `assertProductionSafe` — схема не может выразить правила «зависит от NODE_ENV».
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z
    .string()
    .min(1)
    // Порт 5433 — так проброшен postgres в docker-compose.yml (см. .env.example).
    .default('postgresql://notifications:notifications@localhost:5433/notifications'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
  JWT_TTL: z.string().default('24h'),
  // Безопасный дефолт: эндпоинт выдачи токенов включается только осознанно.
  AUTH_DEV_TOKENS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  NOTIFICATIONS_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  NOTIFICATIONS_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  NOTIFICATIONS_DEDUP_WINDOW_MS: z.coerce.number().int().positive().default(300_000),
  // Транспортный лимит запросов на источник — защита от флуда, не путать с бизнес-лимитом
  // NOTIFICATIONS_RATE_LIMIT (10 уведомлений в минуту одного типа на пользователя).
  HTTP_RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  HTTP_RATE_LIMIT: z.coerce.number().int().positive().default(300),
  HTTP_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  WS_PATH: z.string().default('/ws/notifications'),
  WS_BACKLOG_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  WS_BACKLOG_MAX_PAGES: z.coerce.number().int().positive().default(10),
  WS_PING_INTERVAL_MS: z.coerce.number().int().positive().default(25_000),
  WS_PING_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  WS_MAX_HTTP_BUFFER_SIZE: z.coerce.number().int().positive().default(1_000_000),
  WS_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().positive().default(10),
  WS_ACK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  SWEEPER_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  SWEEPER_MIN_AGE_MS: z.coerce.number().int().nonnegative().default(30_000),
  SWEEPER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  PARTITION_LOOKAHEAD_MONTHS: z.coerce.number().int().nonnegative().default(2),
  RETENTION_MONTHS: z.coerce.number().int().positive().default(6),
  RETENTION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  CORS_ORIGINS: z.string().default('*'),
  REDIS_URL: z.string().optional(),
  /**
   * Включает Nest ScheduleModule / @Cron.
   * В Jest выключается через globalSetup — иначе cron-таймеры держат process alive.
   */
  CRON_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

/**
 * Типизированная конфигурация после разбора env-схемы.
 */
export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Разбирает и валидирует process.env по схеме приложения.
 *
 * Зачем: единая точка входа для конфигурации; дальше код не читает process.env напрямую.
 * Как: при ошибке собирает все проблемы Zod в одно сообщение и бросает Error.
 *
 * @param env - сырой объект переменных окружения (обычно process.env)
 * @returns Разобранная и типизированная конфигурация
 * @throws {Error} Если одна или несколько переменных невалидны
 */
export function parseEnv(env: NodeJS.ProcessEnv): EnvConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Невалидные переменные окружения:\n${details}`);
  }

  assertProductionSafe(result.data);
  return result.data;
}

/**
 * Проверяет правила, которые нельзя выразить в схеме: они зависят от NODE_ENV.
 *
 * Зачем: забытая переменная в production не должна приводить к старту с публично
 * известным секретом — подделать токен в этом случае может любой, кто видел репозиторий.
 * Как: жёстко падаем только на том, что делает систему небезопасной без вариантов;
 * спорные, но осознанные настройки уходят в `productionWarnings`.
 *
 * @param config - уже разобранная конфигурация
 * @returns void
 * @throws {Error} Если production-конфигурация небезопасна
 */
export function assertProductionSafe(config: EnvConfig): void {
  if (config.NODE_ENV !== 'production') {
    return;
  }

  const problems: string[] = [];
  if (config.JWT_SECRET === DEV_JWT_SECRET) {
    problems.push(
      '  - JWT_SECRET: используется дефолтный секрет из репозитория; задайте свой перед деплоем',
    );
  } else if (config.JWT_SECRET.length < PRODUCTION_MIN_JWT_SECRET_LENGTH) {
    problems.push(
      `  - JWT_SECRET: в production требуется минимум ${String(PRODUCTION_MIN_JWT_SECRET_LENGTH)} символов, получено ${String(config.JWT_SECRET.length)}`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`Небезопасная конфигурация production:\n${problems.join('\n')}`);
  }
}

/**
 * Собирает предупреждения о рискованных, но допустимых production-настройках.
 *
 * Зачем: тестовый стенд сознательно открыт (демо-страница выдаёт токены), но это должно
 * быть видно в логах старта, а не оставаться незамеченным на реальном проде.
 * Как: возвращает список строк; логирует их `AppConfigService` при инициализации.
 *
 * @param config - уже разобранная конфигурация
 * @returns Список предупреждений (пустой, если всё строго)
 */
export function productionWarnings(config: EnvConfig): string[] {
  if (config.NODE_ENV !== 'production') {
    return [];
  }

  const warnings: string[] = [];
  if (config.AUTH_DEV_TOKENS_ENABLED) {
    warnings.push(
      'AUTH_DEV_TOKENS_ENABLED=true в production: POST /auth/dev-token выдаёт токен на любой userId ' +
        'и роль service. Допустимо только для публичного демо-стенда — выключите на реальном проде.',
    );
  }
  if (config.CORS_ORIGINS.trim() === '*') {
    warnings.push(
      'CORS_ORIGINS=* в production: API доступен с любого origin. Перечислите домены явно.',
    );
  }
  return warnings;
}
