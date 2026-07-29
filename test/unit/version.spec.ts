import { APP_VERSION, getAppVersion } from '@/version';

describe('version', () => {
  it('возвращает константу версии', () => {
    expect(getAppVersion()).toBe(APP_VERSION);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
