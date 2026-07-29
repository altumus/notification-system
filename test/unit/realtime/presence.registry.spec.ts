import { InMemoryPresenceRegistry } from '@/realtime/presence.registry';

describe('InMemoryPresenceRegistry', () => {
  it('add/remove/isOnline/socketCount', () => {
    const presence = new InMemoryPresenceRegistry();
    const userId = '11111111-1111-4111-8111-111111111111';

    expect(presence.isOnline(userId)).toBe(false);
    presence.add(userId, 's1');
    presence.add(userId, 's2');
    expect(presence.isOnline(userId)).toBe(true);
    expect(presence.socketCount(userId)).toBe(2);
    expect(presence.socketCount()).toBe(2);
    expect(presence.onlineUserIds()).toEqual([userId]);

    presence.remove(userId, 's1');
    expect(presence.socketCount(userId)).toBe(1);
    presence.remove(userId, 's2');
    expect(presence.isOnline(userId)).toBe(false);
    expect(presence.onlineUserIds()).toEqual([]);
  });
});
