import { v4 as uuidV4 } from 'uuid';

import { assertUuidV7, newUuidV7, uuidV7ToDate } from '@/common/utils/uuid-v7';

describe('uuid-v7', () => {
  it('round-trip: uuidV7ToDate(newUuidV7(t)) совпадает с t', () => {
    const samples = [0, 1, 1_700_000_000_000, Date.now(), 2 ** 48 - 1];
    for (const msecs of samples) {
      const id = newUuidV7(msecs);
      expect(uuidV7ToDate(id).getTime()).toBe(msecs);
    }
  });

  it('assertUuidV7 принимает v7 и отклоняет v4', () => {
    expect(() => {
      assertUuidV7(newUuidV7(Date.now()));
    }).not.toThrow();
    expect(() => {
      assertUuidV7(uuidV4());
    }).toThrow(/UUIDv7/);
    expect(() => {
      assertUuidV7('not-a-uuid');
    }).toThrow(/UUIDv7/);
  });

  it('uuidV7ToDate бросает на не-v7', () => {
    expect(() => {
      uuidV7ToDate(uuidV4());
    }).toThrow(/UUIDv7/);
  });
});
