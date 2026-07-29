import { Injectable } from '@nestjs/common';

/**
 * DI-токен реестра присутствия.
 *
 * Зачем токен, а не класс: потребители зависят от интерфейса, поэтому при масштабировании
 * на несколько инстансов реализацию можно заменить на общую (Redis) без их правки.
 */
export const PRESENCE_REGISTRY = Symbol('PRESENCE_REGISTRY');

/**
 * Реестр онлайн-пользователей и их сокетов.
 *
 * Зачем: delivery/sweeper (13–14) и лимит соединений проверяют presence без знания транспорта.
 * Как: add/remove по (userId, socketId); isOnline — есть хотя бы один сокет.
 */
export interface PresenceRegistry {
  /**
   * Регистрирует сокет пользователя.
   *
   * @param userId - идентификатор пользователя
   * @param socketId - id Socket.IO
   * @returns void
   */
  add(userId: string, socketId: string): void;

  /**
   * Снимает сокет с учёта.
   *
   * @param userId - идентификатор пользователя
   * @param socketId - id Socket.IO
   * @returns void
   */
  remove(userId: string, socketId: string): void;

  /**
   * Есть ли хотя бы одно активное соединение.
   *
   * @param userId - идентификатор пользователя
   * @returns true, если онлайн
   */
  isOnline(userId: string): boolean;

  /**
   * Список userId с активными сокетами.
   *
   * @returns Массив userId
   */
  onlineUserIds(): string[];

  /**
   * Число сокетов: всего или у конкретного пользователя.
   *
   * @param userId - если задан — только этот пользователь
   * @returns Количество сокетов
   */
  socketCount(userId?: string): number;
}

/**
 * In-memory реализация PresenceRegistry.
 *
 * Зачем: рассчитана на один инстанс API — этого достаточно для целевых 500k/сутки.
 * Ограничение: при нескольких инстансах каждый видит только свои сокеты, поэтому live-push
 * работает внутри инстанса, а межинстансную доставку добирает `UndeliveredSweeper`.
 * Как: Map userId → Set socketId.
 */
@Injectable()
export class InMemoryPresenceRegistry implements PresenceRegistry {
  private readonly socketsByUser = new Map<string, Set<string>>();

  /**
   * Регистрирует сокет пользователя.
   *
   * @param userId - идентификатор пользователя
   * @param socketId - id Socket.IO
   * @returns void
   */
  public add(userId: string, socketId: string): void {
    let set = this.socketsByUser.get(userId);
    if (set === undefined) {
      set = new Set();
      this.socketsByUser.set(userId, set);
    }
    set.add(socketId);
  }

  /**
   * Снимает сокет; удаляет userId, если сокетов не осталось.
   *
   * @param userId - идентификатор пользователя
   * @param socketId - id Socket.IO
   * @returns void
   */
  public remove(userId: string, socketId: string): void {
    const set = this.socketsByUser.get(userId);
    if (set === undefined) {
      return;
    }
    set.delete(socketId);
    if (set.size === 0) {
      this.socketsByUser.delete(userId);
    }
  }

  /**
   * Проверяет наличие активных сокетов.
   *
   * @param userId - идентификатор пользователя
   * @returns true, если онлайн
   */
  public isOnline(userId: string): boolean {
    const set = this.socketsByUser.get(userId);
    return set !== undefined && set.size > 0;
  }

  /**
   * Возвращает всех онлайн userId.
   *
   * @returns Массив userId
   */
  public onlineUserIds(): string[] {
    return [...this.socketsByUser.keys()];
  }

  /**
   * Считает сокеты.
   *
   * @param userId - опциональный фильтр по пользователю
   * @returns Количество
   */
  public socketCount(userId?: string): number {
    if (userId !== undefined) {
      return this.socketsByUser.get(userId)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.socketsByUser.values()) {
      total += set.size;
    }
    return total;
  }
}
