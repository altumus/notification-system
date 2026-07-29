import { Inject, Logger, UseFilters, UsePipes } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';

import { TokenVerifier } from '../auth/token-verifier.js';
import { AppConfigService } from '../common/config/app-config.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

import { type WsClientPingDto, wsClientPingSchema } from './dto/ws-client-ping.dto.js';
import { buildNotificationsGatewayOptions } from './gateway.options.js';
import { type PresenceRegistry, PRESENCE_REGISTRY } from './presence.registry.js';
import { WsExceptionFilter } from './ws-exception.filter.js';
import { createWsValidationPipe } from './ws-validation.pipe.js';

/**
 * Данные, кладущиеся на socket после успешной авторизации.
 */
interface AuthedSocketData {
  userId: string;
  role: string;
  connectedAt: number;
}

/**
 * Socket.IO шлюз уведомлений: auth, presence, connection.ready.
 *
 * Зачем: R7 — аутентифицированный realtime-канал; доставка событий — в коммите 13.
 * Как: TokenVerifier на connect → join `user:{id}` → PresenceRegistry → unreadCount.
 */
@WebSocketGateway(buildNotificationsGatewayOptions())
@UseFilters(WsExceptionFilter)
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(NotificationsGateway.name);

  /**
   * Локальная карта socketId → userId для надёжного cleanup при disconnect.
   */
  private readonly socketUsers = new Map<string, { userId: string; connectedAt: number }>();

  /**
   * Создаёт gateway.
   *
   * @param tokenVerifier - общая проверка JWT
   * @param presence - реестр присутствия
   * @param notificationsService - счётчик непрочитанных для connection.ready
   * @param config - лимит соединений на пользователя
   */
  public constructor(
    private readonly tokenVerifier: TokenVerifier,
    @Inject(PRESENCE_REGISTRY) private readonly presence: PresenceRegistry,
    private readonly notificationsService: NotificationsService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Авторизует сокет, регистрирует presence и шлёт connection.ready.
   *
   * Зачем: без валидного токена клиент не должен получать события пользователя.
   * Как: handshake.auth.token → TokenVerifier; лимит сокетов; join room; emit ready.
   *
   * @param client - подключающийся сокет
   * @returns void
   */
  public async handleConnection(client: Socket): Promise<void> {
    const token = extractHandshakeToken(client);
    if (token === undefined) {
      this.rejectConnection(client, 'unauthorized', 'Требуется auth.token');
      return;
    }

    let userId: string;
    let role: string;
    try {
      const actor = await this.tokenVerifier.verify(token);
      userId = actor.userId;
      role = actor.role;
    } catch {
      this.rejectConnection(client, 'unauthorized', 'Неверный или просроченный токен');
      return;
    }

    if (this.presence.socketCount(userId) >= this.config.wsMaxConnectionsPerUser) {
      this.rejectConnection(
        client,
        'too_many_connections',
        `Превышен лимит ${String(this.config.wsMaxConnectionsPerUser)} соединений на пользователя`,
      );
      return;
    }

    const connectedAt = Date.now();
    const data: AuthedSocketData = {
      userId,
      role,
      connectedAt,
    };
    client.data = data;
    this.socketUsers.set(client.id, { userId, connectedAt });

    await client.join(userRoom(userId));
    this.presence.add(userId, client.id);

    const unread = await this.notificationsService.countUnread(userId);
    client.emit('connection.ready', {
      unreadCount: unread.count,
      unreadCountExact: unread.exact,
    });

    this.logger.log(
      {
        socketId: client.id,
        userId,
        role,
        socketsForUser: this.presence.socketCount(userId),
      },
      'WS подключено',
    );
  }

  /**
   * Снимает presence и логирует длительность сессии.
   *
   * @param client - отключающийся сокет
   * @returns void
   */
  public handleDisconnect(client: Socket): void {
    const session = this.socketUsers.get(client.id);
    if (session === undefined) {
      return;
    }
    this.socketUsers.delete(client.id);
    this.presence.remove(session.userId, client.id);
    this.logger.log(
      {
        socketId: client.id,
        userId: session.userId,
        durationMs: Date.now() - session.connectedAt,
        stillOnline: this.presence.isOnline(session.userId),
      },
      'WS отключено',
    );
  }

  /**
   * Простой ping для проверки WsValidationPipe и ack.
   *
   * @param body - валидированный payload
   * @param _client - сокет (не используется)
   * @returns pong с nonce
   */
  @SubscribeMessage('client.ping')
  @UsePipes(createWsValidationPipe(wsClientPingSchema))
  public handleClientPing(
    @MessageBody() body: WsClientPingDto,
    @ConnectedSocket() _client: Socket,
  ): { pong: true; nonce: string | null } {
    return { pong: true, nonce: body.nonce ?? null };
  }

  /**
   * Отклоняет соединение с кодом причины.
   *
   * @param client - сокет
   * @param code - машинный код
   * @param message - текст для клиента
   * @returns void
   */
  private rejectConnection(client: Socket, code: string, message: string): void {
    client.emit('connection.error', { code, message });
    client.disconnect(true);
    this.logger.warn({ socketId: client.id, code, message }, 'WS соединение отклонено');
  }
}

/**
 * Имя комнаты пользователя.
 *
 * @param userId - UUID пользователя
 * @returns `user:{userId}`
 */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/**
 * Достаёт JWT из handshake.auth.token или Authorization Bearer.
 *
 * @param client - сокет
 * @returns Токен или undefined
 */
function extractHandshakeToken(client: Socket): string | undefined {
  const auth = client.handshake.auth;
  if (typeof auth === 'object' && 'token' in auth) {
    const authToken: unknown = Reflect.get(auth, 'token');
    if (typeof authToken === 'string' && authToken.length > 0) {
      return authToken;
    }
  }
  const header = client.handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    return token.length > 0 ? token : undefined;
  }
  return undefined;
}
