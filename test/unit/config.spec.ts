import { parseEnv } from '@/common/config/env.schema';

describe('parseEnv', () => {
  const base = {
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-at-least-16',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  };

  it('принимает валидный набор с дефолтами', () => {
    const config = parseEnv(base);
    expect(config.PORT).toBe(3000);
    expect(config.NOTIFICATIONS_RATE_LIMIT).toBe(10);
    expect(config.AUTH_DEV_TOKENS_ENABLED).toBe(true);
    expect(config.RETENTION_ENABLED).toBe(false);
    expect(config.METRICS_ENABLED).toBe(true);
    expect(config.CRON_ENABLED).toBe(true);
    expect(config.SWEEPER_ENABLED).toBe(true);
    expect(config.WS_BACKLOG_MAX_PAGES).toBe(10);
    expect(config.SWEEPER_MIN_AGE_MS).toBe(30_000);
  });

  it('парсит числовые и boolean-поля из строк', () => {
    const config = parseEnv({
      ...base,
      PORT: '4000',
      AUTH_DEV_TOKENS_ENABLED: 'false',
      RETENTION_ENABLED: 'true',
      METRICS_ENABLED: 'false',
      NOTIFICATIONS_RATE_LIMIT: '5',
    });
    expect(config.PORT).toBe(4000);
    expect(config.AUTH_DEV_TOKENS_ENABLED).toBe(false);
    expect(config.RETENTION_ENABLED).toBe(true);
    expect(config.METRICS_ENABLED).toBe(false);
    expect(config.NOTIFICATIONS_RATE_LIMIT).toBe(5);
  });

  it('падает с человекочитаемым списком при невалидном NODE_ENV', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'staging' })).toThrow(
      /Невалидные переменные окружения/,
    );
  });

  it('падает при слишком коротком JWT_SECRET', () => {
    expect(() => parseEnv({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });
});
