import { z } from 'zod';

/**
 * Zod-схема исходящего события `connection.ready`.
 *
 * Зачем: контракт для клиента и e2e; unreadCount для бейджа сразу после коннекта.
 */
export const wsConnectionReadySchema = z.object({
  unreadCount: z.number().int().nonnegative(),
  unreadCountExact: z.boolean(),
});

/**
 * Payload события `connection.ready`.
 */
export type WsConnectionReadyDto = z.infer<typeof wsConnectionReadySchema>;
