import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import { KyselyService } from '../database/kysely.service.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';

/** Окно батчинга markDelivered (мс). */
const FLUSH_WINDOW_MS = 50;

/** Максимум id в одном flush. */
const FLUSH_MAX_IDS = 100;

/**
 * Батч-писатель delivered_at.
 *
 * Зачем: 300 RPS ack не должны превращаться в 300 отдельных UPDATE.
 * Как: буфер id → flush каждые 50 мс или при 100 id; flush на shutdown.
 */
@Injectable()
export class DeliveredBatchWriter implements OnApplicationShutdown {
  private readonly logger = new Logger(DeliveredBatchWriter.name);
  private readonly buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();

  /**
   * Создаёт writer.
   *
   * @param kysely - БД
   * @param repository - markDelivered
   */
  public constructor(
    private readonly kysely: KyselyService,
    private readonly repository: NotificationsRepository,
  ) {}

  /**
   * Ставит id в очередь на markDelivered.
   *
   * @param id - UUIDv7 уведомления
   * @returns void
   */
  public enqueue(id: string): void {
    this.buffer.push(id);
    if (this.buffer.length >= FLUSH_MAX_IDS) {
      void this.flush();
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, FLUSH_WINDOW_MS);
      // Не держим event loop (Jest / graceful shutdown).
      this.timer.unref();
    }
  }

  /**
   * Ставит несколько id в очередь.
   *
   * @param ids - список id
   * @returns void
   */
  public enqueueMany(ids: readonly string[]): void {
    for (const id of ids) {
      this.enqueue(id);
    }
  }

  /**
   * Немедленно сбрасывает буфер в БД.
   *
   * @returns Promise завершения записи
   */
  public async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const ids = this.buffer.splice(0, this.buffer.length);
    if (ids.length === 0) {
      return this.flushing;
    }
    this.flushing = this.flushing.then(async () => {
      try {
        const updated = await this.repository.markDelivered(this.kysely.db, ids);
        this.logger.debug({ ids: ids.length, updated }, 'markDelivered batch');
      } catch (error) {
        this.logger.error({ err: error, ids: ids.length }, 'Не удалось markDelivered batch');
      }
    });
    return this.flushing;
  }

  /**
   * Флашит буфер при остановке приложения.
   *
   * @returns void
   */
  public async onApplicationShutdown(): Promise<void> {
    await this.flush();
  }
}
