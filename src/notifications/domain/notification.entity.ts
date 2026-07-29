/**
 * Доменное представление уведомления (единый контракт REST и WS).
 */
export interface Notification {
  id: string;
  userId: string;
  type: string;
  payload: Record<string, unknown>;
  occurrences: number;
  createdAt: Date;
  lastSeenAt: Date;
  readAt: Date | null;
  deliveredAt: Date | null;
}

/**
 * Результат операции создания уведомления.
 */
export type CreateNotificationResult =
  | { status: 'created'; notification: Notification }
  | { status: 'deduplicated'; notification: Notification };
