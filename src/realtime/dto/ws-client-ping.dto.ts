import { z } from 'zod';

/**
 * Zod-схема входящего `client.ping` (проверка WsValidationPipe).
 */
export const wsClientPingSchema = z
  .object({
    nonce: z.string().max(128).optional(),
  })
  .strict();

/**
 * Типизированный payload `client.ping`.
 */
export type WsClientPingDto = z.infer<typeof wsClientPingSchema>;
