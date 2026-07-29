import { canonicalJson } from '@/common/utils/canonical-json';

describe('canonicalJson', () => {
  it('не зависит от порядка ключей', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('зависит от значений', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });

  it('сортирует вложенные ключи', () => {
    expect(canonicalJson({ z: { b: 1, a: 2 } })).toBe(canonicalJson({ z: { a: 2, b: 1 } }));
  });

  it('отклоняет undefined и циклы', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/цикл/);
  });
});
