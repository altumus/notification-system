import { mapNotificationRow } from '@/notifications/domain/notification.mapper';

describe('mapNotificationRow', () => {
  it('маппит snake_case в доменную сущность', () => {
    const createdAt = new Date('2026-07-29T10:00:00.000Z');
    const notification = mapNotificationRow({
      id: '018f0000-0000-7000-8000-000000000001',
      user_id: '018f0000-0000-7000-8000-000000000002',
      type: 'chat.message',
      payload: { text: 'hi' },
      occurrences: 2,
      created_at: createdAt,
      last_seen_at: createdAt,
      read_at: null,
      delivered_at: null,
    });

    expect(notification).toEqual({
      id: '018f0000-0000-7000-8000-000000000001',
      userId: '018f0000-0000-7000-8000-000000000002',
      type: 'chat.message',
      payload: { text: 'hi' },
      occurrences: 2,
      createdAt,
      lastSeenAt: createdAt,
      readAt: null,
      deliveredAt: null,
    });
  });
});
