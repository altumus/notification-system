import { NotificationTypeConfig } from '@/notifications/domain/notification-type.config';

describe('NotificationTypeConfig', () => {
  const defaults = { rateLimit: 10, rateWindowMs: 60_000, dedupWindowMs: 300_000 };
  const config = NotificationTypeConfig.withDemoTypes(defaults);

  it('возвращает переопределения для известных типов', () => {
    const order = config.resolve('order.status_changed');
    expect(order.dedupKeys).toEqual(['orderId']);
    expect(order.rateLimit).toBe(10);

    const alert = config.resolve('system.alert');
    expect(alert.rateLimit).toBe(5);
  });

  it('неизвестный тип получает дефолты', () => {
    const custom = config.resolve('custom.event');
    expect(custom.rateLimit).toBe(10);
    expect(custom.rateWindowMs).toBe(60_000);
    expect(custom.dedupWindowMs).toBe(300_000);
    expect(custom.dedupKeys).toBeUndefined();
  });

  it('содержит не менее 5 демо-типов', () => {
    expect(config.listKnownTypes().length).toBeGreaterThanOrEqual(5);
  });
});
