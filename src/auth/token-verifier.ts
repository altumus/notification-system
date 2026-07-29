import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { AppConfigService } from '../common/config/app-config.service.js';

/**
 * Роль актора в JWT.
 */
export type ActorRole = 'user' | 'service';

/**
 * Аутентифицированный актор (HTTP или WS).
 */
export interface AuthenticatedActor {
  userId: string;
  role: ActorRole;
}

interface JwtPayload {
  sub: unknown;
  role: unknown;
}

/**
 * Общая проверка JWT для HTTP и WebSocket.
 *
 * Зачем: один TokenVerifier — две guard-реализации не расходятся (коммит 10 плана).
 * Как: JwtService.verifyAsync + проверка role/sub.
 */
@Injectable()
export class TokenVerifier {
  /**
   * Создаёт верификатор токенов.
   *
   * @param jwtService - Nest JWT
   * @param config - конфиг с секретом
   */
  public constructor(
    private readonly jwtService: JwtService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Выпускает dev-токен для произвольного userId/role.
   *
   * @param userId - субъект токена
   * @param role - user или service
   * @returns Подписанный JWT
   */
  public async issueToken(userId: string, role: ActorRole): Promise<string> {
    return this.jwtService.signAsync({ sub: userId, role });
  }

  /**
   * Проверяет Bearer/handshake токен и возвращает актора.
   *
   * @param token - сырой JWT без префикса Bearer
   * @returns AuthenticatedActor
   * @throws {UnauthorizedException} Если токен невалиден или просрочен
   */
  public async verify(token: string): Promise<AuthenticatedActor> {
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: this.config.jwtSecret,
      });
      if (
        typeof payload.sub !== 'string' ||
        payload.sub.length === 0 ||
        (payload.role !== 'user' && payload.role !== 'service')
      ) {
        throw new UnauthorizedException('Некорректный payload токена');
      }
      return { userId: payload.sub, role: payload.role };
    } catch {
      throw new UnauthorizedException('Неверный или просроченный токен');
    }
  }
}
