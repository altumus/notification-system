import { SetMetadata } from '@nestjs/common';

/**
 * Ключ метаданных для публичных маршрутов.
 */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Помечает маршрут как публичный (без JWT).
 *
 * Зачем: health, metrics, docs, dev-token не требуют авторизации.
 * Как: HttpAuthGuard читает метаданные IS_PUBLIC_KEY.
 *
 * @returns MethodDecorator / ClassDecorator
 */
export function Public(): ReturnType<typeof SetMetadata> {
  return SetMetadata(IS_PUBLIC_KEY, true);
}
