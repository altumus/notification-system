import type { Notification } from '../notifications/domain/notification.entity.js';

/**
 * WS DTO уведомления (ISO-даты, как в REST).
 */
export interface NotificationWsDto {
  id: string;
  userId: string;
  type: string;
  payload: Record<string, unknown>;
  occurrences: number;
  createdAt: string;
  lastSeenAt: string;
  readAt: string | null;
  deliveredAt: string | null;
}

/**
 * Маппит доменное уведомление в WS DTO.
 *
 * @param notification - доменная сущность
 * @returns Payload для Socket.IO
 */
export function toNotificationWsDto(notification: Notification): NotificationWsDto {
  return {
    id: notification.id,
    userId: notification.userId,
    type: notification.type,
    payload: notification.payload,
    occurrences: notification.occurrences,
    createdAt: notification.createdAt.toISOString(),
    lastSeenAt: notification.lastSeenAt.toISOString(),
    readAt: notification.readAt?.toISOString() ?? null,
    deliveredAt: notification.deliveredAt?.toISOString() ?? null,
  };
}
