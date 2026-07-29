import { validate as validateUuid } from 'uuid';
import { z } from 'zod';

/**
 * Zod-схема `notification.ack` — клиент подтверждает доставку по id.
 */
export const wsNotificationAckSchema = z
  .object({
    // UUIDv7: стандартный z.uuid() в Zod может отклонять v7.
    ids: z
      .array(z.string().refine((value) => validateUuid(value), { message: 'Invalid uuid' }))
      .min(1)
      .max(100),
  })
  .strict();

/**
 * Типизированный payload `notification.ack`.
 */
export type WsNotificationAckDto = z.infer<typeof wsNotificationAckSchema>;
