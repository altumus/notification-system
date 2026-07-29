import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../common/config/app-config.service.js';

import { type ActorRole, TokenVerifier } from './token-verifier.js';

/**
 * Сервис выдачи dev-JWT.
 *
 * Зачем: демо-страница и e2e получают токен без внешнего IdP.
 * Как: делегирует подпись в TokenVerifier; эндпоинт регистрируется только при флаге.
 */
@Injectable()
export class AuthService {
  /**
   * Создаёт auth-сервис.
   *
   * @param tokenVerifier - выпуск/проверка JWT
   * @param config - env (TTL отображается в ответе)
   */
  public constructor(
    private readonly tokenVerifier: TokenVerifier,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Выдаёт dev-токен.
   *
   * @param userId - субъект
   * @param role - роль
   * @returns token, userId, expiresIn
   */
  public async issueDevToken(
    userId: string,
    role: ActorRole,
  ): Promise<{ token: string; userId: string; expiresIn: string }> {
    const token = await this.tokenVerifier.issueToken(userId, role);
    return { token, userId, expiresIn: this.config.jwtTtl };
  }
}
