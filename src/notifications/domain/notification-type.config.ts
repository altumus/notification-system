/**
 * Эффективные настройки типа уведомления после слияния с глобальными дефолтами.
 */
export interface ResolvedNotificationTypeConfig {
  type: string;
  rateLimit: number;
  rateWindowMs: number;
  dedupWindowMs: number;
  dedupKeys?: readonly string[];
  title?: string;
}

/**
 * Запись в реестре известных типов (переопределения опциональны).
 */
export interface NotificationTypeDefinition {
  type: string;
  rateLimit?: number;
  rateWindowMs?: number;
  dedupWindowMs?: number;
  dedupKeys?: readonly string[];
  title?: string;
}

/**
 * Глобальные дефолты лимитов/окон из env.
 */
export interface NotificationTypeDefaults {
  rateLimit: number;
  rateWindowMs: number;
  dedupWindowMs: number;
}

/**
 * Реестр типов уведомлений с разрешением эффективных настроек.
 *
 * Зачем: разные типы могут иметь свои окна dedup/rate-limit и ключи схлопывания
 * (например orderId), не меняя код сервиса.
 * Как: известные типы описаны в реестре; неизвестный тип разрешён и получает дефолты —
 * продюсеры не должны ждать релиза, чтобы добавить новый type-строку.
 */
export class NotificationTypeConfig {
  private readonly byType: Map<string, NotificationTypeDefinition>;

  /**
   * Создаёт реестр типов.
   *
   * @param defaults - глобальные дефолты из env
   * @param definitions - известные типы (≥5 для демо)
   */
  public constructor(
    private readonly defaults: NotificationTypeDefaults,
    definitions: readonly NotificationTypeDefinition[],
  ) {
    this.byType = new Map(definitions.map((item) => [item.type, item]));
  }

  /**
   * Создаёт реестр с демо-типами задания.
   *
   * @param defaults - глобальные дефолты из env
   * @returns Готовый NotificationTypeConfig
   */
  public static withDemoTypes(defaults: NotificationTypeDefaults): NotificationTypeConfig {
    return new NotificationTypeConfig(defaults, [
      {
        type: 'order.status_changed',
        title: 'Статус заказа',
        dedupKeys: ['orderId'],
      },
      { type: 'chat.message', title: 'Сообщение в чате' },
      { type: 'system.alert', title: 'Системное предупреждение', rateLimit: 5 },
      { type: 'payment.failed', title: 'Ошибка оплаты', dedupKeys: ['paymentId'] },
      { type: 'friend.request', title: 'Запрос в друзья', dedupKeys: ['fromUserId'] },
    ]);
  }

  /**
   * Возвращает эффективные настройки для типа.
   *
   * @param type - строка типа уведомления
   * @returns Слияние реестра и глобальных дефолтов
   */
  public resolve(type: string): ResolvedNotificationTypeConfig {
    const defined = this.byType.get(type);
    const resolved: ResolvedNotificationTypeConfig = {
      type,
      rateLimit: defined?.rateLimit ?? this.defaults.rateLimit,
      rateWindowMs: defined?.rateWindowMs ?? this.defaults.rateWindowMs,
      dedupWindowMs: defined?.dedupWindowMs ?? this.defaults.dedupWindowMs,
    };
    if (defined?.dedupKeys !== undefined) {
      resolved.dedupKeys = defined.dedupKeys;
    }
    if (defined?.title !== undefined) {
      resolved.title = defined.title;
    }
    return resolved;
  }

  /**
   * Список известных типов (для демо-формы и метрик).
   *
   * @returns Массив определений из реестра
   */
  public listKnownTypes(): readonly NotificationTypeDefinition[] {
    return [...this.byType.values()];
  }
}
