import { z } from 'zod';

/**
 * Zod-схема `notification.fetchUnread`.
 */
export const wsFetchUnreadSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

/**
 * Типизированный payload `notification.fetchUnread`.
 */
export type WsFetchUnreadDto = z.infer<typeof wsFetchUnreadSchema>;
