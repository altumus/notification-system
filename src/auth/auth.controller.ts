import { randomUUID } from 'node:crypto';

import { Body, Controller, NotFoundException, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

import { AppConfigService } from '../common/config/app-config.service.js';

import { AuthService } from './auth.service.js';
import { Public } from './decorators/public.decorator.js';
import type { ActorRole } from './token-verifier.js';

/**
 * DTO выдачи dev-токена.
 */
class DevTokenDto {
  @IsOptional()
  @IsUUID()
  public userId?: string;

  @IsOptional()
  @IsIn(['user', 'service'])
  public role?: ActorRole;
}

/**
 * HTTP-эндпоинт выдачи dev-JWT.
 *
 * Зачем: демо и тесты; в production при выключенном флаге маршрут даёт 404 (как «нет эндпоинта»).
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  /**
   * Создаёт контроллер auth.
   *
   * @param authService - выпуск токенов
   * @param config - флаг AUTH_DEV_TOKENS_ENABLED
   */
  public constructor(
    private readonly authService: AuthService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Выдаёт JWT для произвольного userId.
   *
   * @param body - userId и role (опционально)
   * @returns token, userId, expiresIn
   * @throws {NotFoundException} Если dev-токены выключены
   */
  @Public()
  @Post('dev-token')
  @ApiOperation({ summary: 'Выдать dev-JWT (только при AUTH_DEV_TOKENS_ENABLED)' })
  public async issueDevToken(
    @Body() body: DevTokenDto,
  ): Promise<{ token: string; userId: string; expiresIn: string }> {
    if (!this.config.authDevTokensEnabled) {
      throw new NotFoundException();
    }
    const userId = body.userId ?? randomUUID();
    const role = body.role ?? 'user';
    return this.authService.issueDevToken(userId, role);
  }
}
