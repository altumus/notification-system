import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthenticatedActor } from '../token-verifier.js';

/**
 * Достаёт AuthenticatedActor, положенный HttpAuthGuard в request.
 *
 * Зачем: контроллеры не читают request вручную.
 * Как: createParamDecorator → request.user.
 *
 * @param _data - не используется
 * @param ctx - контекст Nest
 * @returns AuthenticatedActor
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedActor => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthenticatedActor }>();
    return request.user;
  },
);
