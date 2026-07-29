import { Injectable } from '@nestjs/common';

/**
 * Хуки счётчиков доставки (реализация Prometheus — коммит 17).
 *
 * Зачем: коммит 13 уже фиксирует точки учёта delivered / ack_timeout / offline-skip.
 * Как: in-memory инкременты; в 17 заменятся на prom-client без смены вызовов.
 */
@Injectable()
export class DeliveryMetrics {
  private deliveredCount = 0;
  private ackTimeoutCount = 0;
  private pushSkippedOfflineCount = 0;

  /**
   * Учитывает успешный ack и запись delivered_at.
   *
   * @returns void
   */
  public delivered(): void {
    this.deliveredCount += 1;
  }

  /**
   * Учитывает таймаут/ошибку ack (delivered_at не ставится).
   *
   * @returns void
   */
  public ackTimeout(): void {
    this.ackTimeoutCount += 1;
  }

  /**
   * Учитывает пропуск push: пользователь офлайн.
   *
   * @returns void
   */
  public pushSkippedOffline(): void {
    this.pushSkippedOfflineCount += 1;
  }

  /**
   * Снимок счётчиков (для тестов до появления /metrics).
   *
   * @returns Текущие значения
   */
  public snapshot(): {
    delivered: number;
    ackTimeout: number;
    pushSkippedOffline: number;
  } {
    return {
      delivered: this.deliveredCount,
      ackTimeout: this.ackTimeoutCount,
      pushSkippedOffline: this.pushSkippedOfflineCount,
    };
  }
}
