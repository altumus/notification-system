import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { AppConfigService } from '../common/config/app-config.service.js';
import { KyselyService } from '../database/kysely.service.js';
import { mapNotificationRow } from '../notifications/domain/notification.mapper.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';

import { DeliveredBatchWriter } from './delivered-batch.writer.js';
import { DeliveryMetrics } from './delivery.metrics.js';
import { NotificationsGateway } from './notifications.gateway.js';
import { type PresenceRegistry, PRESENCE_REGISTRY } from './presence.registry.js';

/** Сколько недоставленных максимум обрабатываем за один тик. */
const SWEEPER_TICK_LIMIT = 200;

/**
 * Фоновый дожим недоставленных для онлайн-пользователей.
 *
 * Зачем: ловит падение инстанса между COMMIT и push и потерянные ack. Он же — страховка
 * при нескольких инстансах: presence локален для процесса, поэтому уведомление, созданное
 * там, где у пользователя нет сокета, догоняет его этим проходом.
 * Как: setInterval → onlineUserIds → listUndeliveredForUsers (старше minAge) → deliverCreated.
 */
@Injectable()
export class UndeliveredSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UndeliveredSweeper.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  /**
   * Создаёт sweeper.
   *
   * @param presence - кто онлайн
   * @param kysely - БД
   * @param repository - выборка недоставленных
   * @param gateway - live push с ack
   * @param deliveredBatch - батч markDelivered
   * @param metrics - хуки счётчиков
   * @param config - интервал и minAge
   */
  public constructor(
    @Inject(PRESENCE_REGISTRY) private readonly presence: PresenceRegistry,
    private readonly kysely: KyselyService,
    private readonly repository: NotificationsRepository,
    private readonly gateway: NotificationsGateway,
    private readonly deliveredBatch: DeliveredBatchWriter,
    private readonly metrics: DeliveryMetrics,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Запускает интервал, если sweeper включён.
   *
   * @returns void
   */
  public onModuleInit(): void {
    if (!this.config.sweeperEnabled) {
      this.logger.debug('UndeliveredSweeper выключен (SWEEPER_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.sweeperIntervalMs);
    // Не держим Jest/event loop, если кроме sweeper ничего не осталось.
    this.timer.unref();
  }

  /**
   * Останавливает интервал.
   *
   * @returns void
   */
  public onModuleDestroy(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Один проход sweeper (публичен для e2e).
   *
   * @returns Число успешно подтверждённых доставок
   */
  public async tick(): Promise<number> {
    if (this.ticking) {
      return 0;
    }
    this.ticking = true;
    try {
      const userIds = this.presence.onlineUserIds();
      if (userIds.length === 0) {
        return 0;
      }

      const olderThan = new Date(Date.now() - this.config.sweeperMinAgeMs);
      const retentionStart = new Date();
      retentionStart.setUTCMonth(retentionStart.getUTCMonth() - this.config.retentionMonths);

      const rows = await this.repository.listUndeliveredForUsers(
        this.kysely.db,
        userIds,
        olderThan,
        retentionStart,
        SWEEPER_TICK_LIMIT,
      );
      if (rows.length === 0) {
        return 0;
      }

      let delivered = 0;
      for (const row of rows) {
        if (!this.presence.isOnline(row.user_id)) {
          continue;
        }
        const notification = mapNotificationRow(row);
        const acked = await this.gateway.deliverCreated(notification);
        if (acked) {
          this.deliveredBatch.enqueue(notification.id);
          this.metrics.delivered();
          delivered += 1;
        } else {
          this.metrics.ackTimeout();
        }
      }

      if (delivered > 0) {
        this.logger.debug({ delivered, scanned: rows.length }, 'Sweeper дожал недоставленные');
      }
      return delivered;
    } catch (error) {
      this.logger.error({ err: error }, 'Ошибка тика UndeliveredSweeper');
      return 0;
    } finally {
      this.ticking = false;
    }
  }
}
