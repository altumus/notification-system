import { z } from 'zod';

/**
 * Zod-схема всех переменных окружения приложения.
 *
 * Зачем: fail-fast на старте с человекочитаемым списком проблем вместо падений в рантайме.
 * Как: дефолты безопасны для локальной разработки; в production секреты валидируются жёстче (коммит 20).
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
  JWT_SECRET: z.string().min(16).default('dev-only-jwt-secret-change-me'),
  JWT_TTL: z.string().default('24h'),
  AUTH_DEV_TOKENS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  NOTIFICATIONS_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  NOTIFICATIONS_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  NOTIFICATIONS_DEDUP_WINDOW_MS: z.coerce.number().int().positive().default(300_000),
  WS_PATH: z.string().default('/ws/notifications'),
  WS_BACKLOG_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  SWEEPER_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  PARTITION_LOOKAHEAD_MONTHS: z.coerce.number().int().nonnegative().default(2),
  RETENTION_MONTHS: z.coerce.number().int().positive().default(6),
  RETENTION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  CORS_ORIGINS: z.string().default('*'),
  REDIS_URL: z.string().optional(),
  METRICS_ENABLED: z
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
  if (result.success) {
    return result.data;
  }

  const details = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new Error(`Невалидные переменные окружения:\n${details}`);
}
