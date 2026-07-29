import type { EventEmitter2 } from '@nestjs/event-emitter';

import type { AppConfigService } from '@/common/config/app-config.service';
import type { KyselyService } from '@/database/kysely.service';
import type { NotificationsRepository } from '@/notifications/notifications.repository';
import {
  NOTIFICATION_CREATED_EVENT,
  NotificationsService,
} from '@/notifications/notifications.service';

/**
 * Собирает NotificationsService с заглушками транзакции и репозитория.
 *
 * @param repository - мок репозитория
 * @param emit - jest-мок emit
 * @returns Сервис для unit-тестов
 */
function buildService(repository: NotificationsRepository, emit: jest.Mock): NotificationsService {
  const db = {
    transaction: () => ({
      execute: async <T>(fn: (trx: unknown) => Promise<T>): Promise<T> => fn({}),
    }),
  };
  const kyselyService = { db } as unknown as KyselyService;
  const config = {
    notificationsRateLimit: 10,
    notificationsRateWindowMs: 60_000,
    notificationsDedupWindowMs: 300_000,
  } as AppConfigService;
  const eventEmitter = { emit } as unknown as EventEmitter2;
  return new NotificationsService(kyselyService, repository, config, eventEmitter);
}

describe('NotificationsService (unit)', () => {
  const now = new Date('2026-07-29T12:00:00.000Z');

  it('эмитит notification.created только при status=created', async () => {
    const row = {
      id: '018f0000-0000-7000-8000-000000000001',
      user_id: '018f0000-0000-7000-8000-000000000002',
      type: 'chat.message',
      payload: { text: 'x' },
      occurrences: 1,
      created_at: now,
      last_seen_at: now,
      read_at: null,
      delivered_at: null,
    };
    const repository = {
      acquireUserTypeLock: jest.fn().mockResolvedValue({ now }),
      findDedupAnchor: jest.fn().mockResolvedValue(null),
      countInRateWindow: jest.fn().mockResolvedValue({ used: 0, oldest: null }),
      insert: jest.fn().mockResolvedValue(row),
      incrementOccurrences: jest.fn(),
    } as unknown as NotificationsRepository;
    const emit = jest.fn();
    const service = buildService(repository, emit);

    const result = await service.create({
      userId: row.user_id,
      type: row.type,
      payload: row.payload,
    });

    expect(result.status).toBe('created');
    expect(emit).toHaveBeenCalledWith(
      NOTIFICATION_CREATED_EVENT,
      expect.objectContaining({ id: row.id }),
    );
  });

  it('не эмитит событие при deduplicated', async () => {
    const anchor = {
      id: '018f0000-0000-7000-8000-000000000001',
      user_id: '018f0000-0000-7000-8000-000000000002',
      type: 'order.status_changed',
      payload: { orderId: 1 },
      occurrences: 1,
      created_at: now,
      last_seen_at: now,
      read_at: null,
      delivered_at: null,
    };
    const repository = {
      acquireUserTypeLock: jest.fn().mockResolvedValue({ now }),
      findDedupAnchor: jest.fn().mockResolvedValue(anchor),
      incrementOccurrences: jest.fn().mockResolvedValue({ ...anchor, occurrences: 2 }),
      countInRateWindow: jest.fn(),
      insert: jest.fn(),
    } as unknown as NotificationsRepository;
    const emit = jest.fn();
    const service = buildService(repository, emit);

    const result = await service.create({
      userId: anchor.user_id,
      type: anchor.type,
      payload: anchor.payload,
    });

    expect(result.status).toBe('deduplicated');
    expect(emit).not.toHaveBeenCalled();
  });
});
