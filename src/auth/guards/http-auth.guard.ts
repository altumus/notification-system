import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import type { AuthenticatedActor } from '../token-verifier.js';
import { TokenVerifier } from '../token-verifier.js';

/**
 * Глобальный HTTP-guard JWT.
 *
 * Зачем: все маршруты требуют токен, кроме помеченных @Public().
 * Как: читает Authorization Bearer → TokenVerifier.verify → request.user.
 */
@Injectable()
export class HttpAuthGuard implements CanActivate {
  /**
   * Создаёт guard.
   *
   * @param tokenVerifier - общая проверка JWT
   * @param reflector - чтение @Public()
   */
  public constructor(
    private readonly tokenVerifier: TokenVerifier,
    private readonly reflector: Reflector,
  ) {}

  /**
   * Разрешает запрос при валидном токене или публичном маршруте.
   *
   * @param context - HTTP-контекст
   * @returns true, если доступ разрешён
   * @throws {UnauthorizedException} Если токена нет или он невалиден
   */
  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      originalUrl?: string;
      url?: string;
      user?: AuthenticatedActor;
    }>();
    // Swagger и статика демо-страницы — UI без JWT (сами по себе данных не отдают).
    const path = request.originalUrl ?? request.url ?? '';
    if (path.startsWith('/api/docs') || path === '/demo' || path.startsWith('/demo/')) {
      return true;
    }

    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Требуется Authorization: Bearer <token>');
    }
    const token = header.slice('Bearer '.length).trim();
    if (token.length === 0) {
      throw new UnauthorizedException('Пустой Bearer-токен');
    }
    request.user = await this.tokenVerifier.verify(token);
    return true;
  }
}
