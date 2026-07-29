/**
 * Версия приложения из package.json на этапе сборки тулинга.
 *
 * Зачем: единая константа версии для health-ответа и логов старта.
 * Как: константа обновляется при релизе; не путать с runtime ConfigService.
 */
export const APP_VERSION = '0.0.0';

/**
 * Возвращает строку версии для логов и health-ответов.
 *
 * Зачем: единая точка чтения версии без прямого импорта package.json в рантайме.
 * Как: возвращает константу APP_VERSION.
 *
 * @returns Текущая версия приложения в semver-формате
 */
export function getAppVersion(): string {
  return APP_VERSION;
}
