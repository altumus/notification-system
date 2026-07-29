/**
 * Детерминированно сериализует значение в JSON со стабильным порядком ключей.
 *
 * Зачем: dedup_hash не должен зависеть от порядка ключей в payload продюсера —
 * иначе один и тот же смысл даст разные хеши и схлопывание не сработает (R6).
 * Как: рекурсивный обход с сортировкой ключей объектов; массивы сохраняют порядок;
 * `undefined` и циклические ссылки запрещены (бросают ошибку).
 *
 * @param value - JSON-совместимое значение
 * @returns Каноническая JSON-строка
 * @throws {TypeError} При undefined, bigint, function, symbol или цикле
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new Set<object>()));
}

/**
 * Нормализует значение для канонической сериализации.
 *
 * @param value - исходное значение
 * @param seen - множество уже посещённых объектов (защита от циклов)
 * @returns Нормализованное значение, пригодное для JSON.stringify
 */
function normalize(value: unknown, seen: Set<object>): unknown {
  if (value === null) {
    return null;
  }
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') {
    return value;
  }
  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalJson: нечисловые Number запрещены');
    }
    return value;
  }
  if (
    valueType === 'undefined' ||
    valueType === 'function' ||
    valueType === 'symbol' ||
    valueType === 'bigint'
  ) {
    throw new TypeError(`canonicalJson: тип ${valueType} запрещён`);
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    throw new TypeError('canonicalJson: обнарущена циклическая ссылка');
  }
  seen.add(objectValue);

  if (Array.isArray(value)) {
    const result = value.map((item) => normalize(item, seen));
    seen.delete(objectValue);
    return result;
  }

  if (value instanceof Date) {
    seen.delete(objectValue);
    return value.toISOString();
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  const normalized: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const entry = record[key];
    if (entry === undefined) {
      throw new TypeError(`canonicalJson: ключ "${key}" имеет значение undefined`);
    }
    normalized[key] = normalize(entry, seen);
  }
  seen.delete(objectValue);
  return normalized;
}
