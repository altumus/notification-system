import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';

import type { AuthenticatedActor } from '../token-verifier.js';
import { TokenVerifier } from '../token-verifier.js';

/**
 * Guard авторизации Socket.IO (handshake.auth.token).
 *
 * Зачем: тот же TokenVerifier, что и для HTTP — без второй реализации.
 * Как: читает client.handshake.auth.token → verify → socket.data.user.
 */
@Injectable()
export class WsAuthGuard implements CanActivate {
  /**
   * Создаёт WS-guard.
   *
   * @param tokenVerifier - общая проверка JWT
   */
  public constructor(private readonly tokenVerifier: TokenVerifier) {}

  /**
   * Проверяет токен в handshake.
   *
   * @param context - WS-контекст
   * @returns true при успехе
   * @throws {WsException} При невалидном токене
   */
  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<{
      handshake: { auth?: { token?: string } };
      data: { user?: AuthenticatedActor };
    }>();
    const token = client.handshake.auth?.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new WsException({ code: 'unauthorized', message: 'Требуется auth.token' });
    }
    try {
      client.data.user = await this.tokenVerifier.verify(token);
      return true;
    } catch {
      throw new WsException({ code: 'unauthorized', message: 'Неверный или просроченный токен' });
    }
  }
}
