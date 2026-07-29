import { decodeKeysetCursor, encodeKeysetCursor } from '@/common/pagination/keyset-cursor';
import { newUuidV7 } from '@/common/utils/uuid-v7';
import { InvalidCursorError } from '@/notifications/domain/errors';

describe('keyset-cursor', () => {
  it('round-trip encode/decode', () => {
    const payload = { createdAt: new Date('2026-07-29T10:15:00.123Z'), id: newUuidV7(Date.now()) };
    const decoded = decodeKeysetCursor(encodeKeysetCursor(payload));
    expect(decoded.id).toBe(payload.id);
    expect(decoded.createdAt.toISOString()).toBe(payload.createdAt.toISOString());
  });

  it('битый курсор бросает InvalidCursorError', () => {
    expect(() => decodeKeysetCursor('%%%')).toThrow(InvalidCursorError);
    expect(() => decodeKeysetCursor(Buffer.from('{"v":2}', 'utf8').toString('base64url'))).toThrow(
      InvalidCursorError,
    );
  });
});
