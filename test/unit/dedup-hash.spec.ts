import { buildDedupHash } from '@/notifications/domain/dedup-hash';

describe('buildDedupHash', () => {
  const base = {
    userId: '11111111-1111-4111-8111-111111111111',
    type: 'order.status_changed',
  };

  it('не зависит от порядка ключей payload', () => {
    const a = buildDedupHash({ ...base, payload: { orderId: 1, status: 'x' } });
    const b = buildDedupHash({ ...base, payload: { status: 'x', orderId: 1 } });
    expect(a.equals(b)).toBe(true);
  });

  it('зависит от значений payload', () => {
    const a = buildDedupHash({ ...base, payload: { orderId: 1 } });
    const b = buildDedupHash({ ...base, payload: { orderId: 2 } });
    expect(a.equals(b)).toBe(false);
  });

  it('dedupKeys учитывает только указанные поля', () => {
    const a = buildDedupHash({
      ...base,
      payload: { orderId: 1, status: 'new' },
      dedupKeys: ['orderId'],
    });
    const b = buildDedupHash({
      ...base,
      payload: { orderId: 1, status: 'shipped' },
      dedupKeys: ['orderId'],
    });
    expect(a.equals(b)).toBe(true);
  });

  it('разные userId или type дают разный хеш', () => {
    const a = buildDedupHash({ ...base, payload: { orderId: 1 } });
    const b = buildDedupHash({
      ...base,
      userId: '22222222-2222-4222-8222-222222222222',
      payload: { orderId: 1 },
    });
    expect(a.equals(b)).toBe(false);
  });
});
