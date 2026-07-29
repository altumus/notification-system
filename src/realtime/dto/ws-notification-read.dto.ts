import { validate as validateUuid } from 'uuid';
import { z } from 'zod';

/**
 * Zod-схема входящего `notification.read`.
 */
export const wsNotificationReadSchema = z
  .object({
    id: z.string().refine((value) => validateUuid(value), { message: 'Invalid uuid' }),
  })
  .strict();

/**
 * Типизированный payload `notification.read` (in).
 */
export type WsNotificationReadDto = z.infer<typeof wsNotificationReadSchema>;
