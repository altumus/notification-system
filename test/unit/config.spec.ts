import { DEV_JWT_SECRET, parseEnv, productionWarnings } from '@/common/config/env.schema';

describe('parseEnv', () => {
  const base = {
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-at-least-16',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  };

  /** Валидный production-набор: 32+ символов и не дефолтный секрет. */
  const prodBase = {
    ...base,
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(32),
  };

  it('принимает валидный набор с дефолтами', () => {
    const config = parseEnv(base);
    expect(config.PORT).toBe(3000);
    expect(config.NOTIFICATIONS_RATE_LIMIT).toBe(10);
    expect(config.RETENTION_ENABLED).toBe(false);
    expect(config.CRON_ENABLED).toBe(true);
    expect(config.SWEEPER_ENABLED).toBe(true);
    expect(config.WS_BACKLOG_MAX_PAGES).toBe(10);
    expect(config.SWEEPER_MIN_AGE_MS).toBe(30_000);
  });

  it('по умолчанию выдача dev-токенов выключена', () => {
    expect(parseEnv(base).AUTH_DEV_TOKENS_ENABLED).toBe(false);
  });

  it('транспортный лимит частоты включён по умолчанию', () => {
    const config = parseEnv(base);
    expect(config.HTTP_RATE_LIMIT_ENABLED).toBe(true);
    expect(config.HTTP_RATE_LIMIT).toBe(300);
    expect(config.HTTP_RATE_WINDOW_MS).toBe(60_000);
  });

  it('транспортный лимит частоты отключаем флагом', () => {
    const config = parseEnv({ ...base, HTTP_RATE_LIMIT_ENABLED: 'false', HTTP_RATE_LIMIT: '50' });
    expect(config.HTTP_RATE_LIMIT_ENABLED).toBe(false);
    expect(config.HTTP_RATE_LIMIT).toBe(50);
  });

  it('парсит числовые и boolean-поля из строк', () => {
    const config = parseEnv({
      ...base,
      PORT: '4000',
      AUTH_DEV_TOKENS_ENABLED: 'true',
      RETENTION_ENABLED: 'true',
      NOTIFICATIONS_RATE_LIMIT: '5',
    });
    expect(config.PORT).toBe(4000);
    expect(config.AUTH_DEV_TOKENS_ENABLED).toBe(true);
    expect(config.RETENTION_ENABLED).toBe(true);
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

  describe('production', () => {
    it('не даёт стартовать с дефолтным секретом из репозитория', () => {
      expect(() => parseEnv({ ...prodBase, JWT_SECRET: DEV_JWT_SECRET })).toThrow(
        /Небезопасная конфигурация production[\s\S]*JWT_SECRET/,
      );
    });

    it('не даёт стартовать без JWT_SECRET (подставился бы дефолт)', () => {
      const { JWT_SECRET: _omitted, ...withoutSecret } = prodBase;
      expect(() => parseEnv(withoutSecret)).toThrow(/JWT_SECRET/);
    });

    it('требует минимум 32 символа секрета', () => {
      expect(() => parseEnv({ ...prodBase, JWT_SECRET: 'b'.repeat(31) })).toThrow(
        /минимум 32 символов/,
      );
      expect(() => parseEnv({ ...prodBase, JWT_SECRET: 'b'.repeat(32) })).not.toThrow();
    });

    it('предупреждает про dev-токены и открытый CORS, но не падает', () => {
      const config = parseEnv({
        ...prodBase,
        AUTH_DEV_TOKENS_ENABLED: 'true',
        CORS_ORIGINS: '*',
      });
      const warnings = productionWarnings(config);
      expect(warnings).toHaveLength(2);
      expect(warnings.join('\n')).toMatch(/AUTH_DEV_TOKENS_ENABLED/);
      expect(warnings.join('\n')).toMatch(/CORS_ORIGINS/);
    });

    it('без предупреждений при строгой конфигурации', () => {
      const config = parseEnv({
        ...prodBase,
        AUTH_DEV_TOKENS_ENABLED: 'false',
        CORS_ORIGINS: 'https://example.com',
      });
      expect(productionWarnings(config)).toEqual([]);
    });

    it('вне production предупреждений нет даже при слабых настройках', () => {
      const config = parseEnv({ ...base, AUTH_DEV_TOKENS_ENABLED: 'true', CORS_ORIGINS: '*' });
      expect(productionWarnings(config)).toEqual([]);
    });
  });
});
