import { Injectable } from '@nestjs/common';

/**
 * Счётчики доставки: delivered / ack_timeout / offline-skip.
 *
 * Зачем: точки учёта собраны в одном месте — тесты проверяют исходы доставки,
 * а внешний экспорт свёлся бы к замене реализации без правки вызывающего кода.
 * Как: in-memory инкременты в рамках процесса.
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
   * Снимок счётчиков.
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
