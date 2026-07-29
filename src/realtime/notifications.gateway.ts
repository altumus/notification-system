import { Inject, Logger, UseFilters } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import { TokenVerifier } from '../auth/token-verifier.js';
import { AppConfigService } from '../common/config/app-config.service.js';
import type { Notification } from '../notifications/domain/notification.entity.js';
import { NotificationsService } from '../notifications/notifications.service.js';

import { DeliveredBatchWriter } from './delivered-batch.writer.js';
import { type WsClientPingDto, wsClientPingSchema } from './dto/ws-client-ping.dto.js';
import { type WsFetchUnreadDto, wsFetchUnreadSchema } from './dto/ws-fetch-unread.dto.js';
import {
  type WsNotificationAckDto,
  wsNotificationAckSchema,
} from './dto/ws-notification-ack.dto.js';
import {
  type WsNotificationReadDto,
  wsNotificationReadSchema,
} from './dto/ws-notification-read.dto.js';
import { buildNotificationsGatewayOptions } from './gateway.options.js';
import { toNotificationWsDto } from './notification-ws.mapper.js';
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
 * Payload broadcast `notification.read`.
 */
interface BroadcastReadPayload {
  id: string;
  userId: string;
  readAt: string | null;
}

/**
 * Socket.IO шлюз уведомлений: auth, presence, push с ack.
 *
 * Зачем: R7 — realtime-доставка; delivered_at только после ack (at-least-once).
 * Как: TokenVerifier на connect; DeliveryDispatcher → deliverCreated; handlers ack/read/fetch.
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
   * Сервер Socket.IO namespace (для room broadcast / emitWithAck).
   */
  @WebSocketServer()
  private server: Server | undefined;

  /**
   * Создаёт gateway.
   *
   * @param tokenVerifier - общая проверка JWT
   * @param presence - реестр присутствия
   * @param notificationsService - create/read/unread
   * @param config - лимит соединений и ack timeout
   * @param deliveredBatch - батч markDelivered
   */
  public constructor(
    private readonly tokenVerifier: TokenVerifier,
    @Inject(PRESENCE_REGISTRY) private readonly presence: PresenceRegistry,
    private readonly notificationsService: NotificationsService,
    private readonly config: AppConfigService,
    private readonly deliveredBatch: DeliveredBatchWriter,
  ) {}

  /**
   * Авторизует сокет, регистрирует presence и шлёт connection.ready.
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
   * Пушит notification.created во все сокеты пользователя и ждёт ack.
   *
   * Зачем: at-least-once — достаточно одного успешного ack среди вкладок.
   * Как: fetchSockets → timeout(emitWithAck) на каждый; true если хотя бы один ответил.
   *
   * @param notification - доменная сущность
   * @returns true, если хотя бы один сокет подтвердил
   */
  public async deliverCreated(notification: Notification): Promise<boolean> {
    if (this.server === undefined) {
      return false;
    }
    const dto = toNotificationWsDto(notification);
    const sockets = await this.server.in(userRoom(notification.userId)).fetchSockets();
    if (sockets.length === 0) {
      return false;
    }

    const results = await Promise.all(
      sockets.map(async (socket) => {
        try {
          await socket.timeout(this.config.wsAckTimeoutMs).emitWithAck('notification.created', dto);
          return true;
        } catch {
          return false;
        }
      }),
    );
    return results.some((acked) => acked);
  }

  /**
   * Broadcast `notification.read` во все сокеты пользователя.
   *
   * @param payload - данные прочтения (id, userId, readAt ISO)
   * @returns void
   */
  public broadcastRead(payload: BroadcastReadPayload): void {
    this.server?.to(userRoom(payload.userId)).emit('notification.read', payload);
  }

  /**
   * Простой ping для проверки WsValidationPipe и ack.
   *
   * @param body - валидированный payload
   * @returns pong с nonce
   */
  @SubscribeMessage('client.ping')
  public handleClientPing(
    @MessageBody(createWsValidationPipe(wsClientPingSchema)) body: WsClientPingDto,
  ): { pong: true; nonce: string | null } {
    return { pong: true, nonce: body.nonce ?? null };
  }

  /**
   * Ручное подтверждение доставки по списку id.
   *
   * @param body - ids
   * @param client - сокет
   * @returns ok
   */
  @SubscribeMessage('notification.ack')
  public handleNotificationAck(
    @MessageBody(createWsValidationPipe(wsNotificationAckSchema)) body: WsNotificationAckDto,
    @ConnectedSocket() client: Socket,
  ): { ok: true } {
    this.requireUserId(client);
    this.deliveredBatch.enqueueMany(body.ids);
    return { ok: true };
  }

  /**
   * Помечает уведомление прочитанным и синхронизирует вкладки через событие домена.
   *
   * @param body - id
   * @param client - сокет
   * @returns Результат markAsRead
   */
  @SubscribeMessage('notification.read')
  public async handleNotificationRead(
    @MessageBody(createWsValidationPipe(wsNotificationReadSchema)) body: WsNotificationReadDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ ok: true; notification: ReturnType<typeof toNotificationWsDto> }> {
    const userId = this.requireUserId(client);
    const notification = await this.notificationsService.markAsRead(userId, body.id);
    return { ok: true, notification: toNotificationWsDto(notification) };
  }

  /**
   * Запрашивает страницу непрочитанных по WS (keyset).
   *
   * @param body - limit/cursor
   * @param client - сокет
   * @returns Страница unread
   */
  @SubscribeMessage('notification.fetchUnread')
  public async handleFetchUnread(
    @MessageBody(createWsValidationPipe(wsFetchUnreadSchema)) body: WsFetchUnreadDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{
    items: ReturnType<typeof toNotificationWsDto>[];
    nextCursor: string | null;
    unreadCount: number;
    unreadCountExact: boolean;
  }> {
    const userId = this.requireUserId(client);
    const result = await this.notificationsService.listUnread(
      userId,
      body.limit ?? 20,
      body.cursor,
    );
    return {
      items: result.items.map(toNotificationWsDto),
      nextCursor: result.nextCursor,
      unreadCount: result.unreadCount,
      unreadCountExact: result.unreadCountExact,
    };
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

  /**
   * Достаёт userId авторизованного сокета.
   *
   * @param client - сокет
   * @returns userId
   * @throws {WsException} Если сессия неизвестна
   */
  private requireUserId(client: Socket): string {
    const session = this.socketUsers.get(client.id);
    if (session === undefined) {
      throw new WsException({
        error: { code: 'unauthorized', message: 'Сокет не авторизован' },
      });
    }
    return session.userId;
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
