import type { Notification } from './notification.entity.js';

/**
 * Строка БД notifications (snake_case), как её возвращает репозиторий.
 */
export interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  payload: Record<string, unknown>;
  occurrences: number;
  created_at: Date;
  last_seen_at: Date;
  read_at: Date | null;
  delivered_at: Date | null;
}

/**
 * Преобразует строку БД в доменный объект Notification.
 *
 * Зачем: слой сервиса и API не должны знать про snake_case колонок Postgres.
 * Как: прямое сопоставление полей; даты уже Date из драйвера pg.
 *
 * @param row - строка из SELECT/RETURNING
 * @returns Доменное уведомление
 */
export function mapNotificationRow(row: NotificationRow): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    payload: row.payload,
    occurrences: row.occurrences,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    readAt: row.read_at,
    deliveredAt: row.delivered_at,
  };
}
