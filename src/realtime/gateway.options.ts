/**
 * Читает целое из process.env с запасным значением.
 *
 * Зачем: опции `@WebSocketGateway` задаются на этапе загрузки модуля, до DI.
 * Как: Number(process.env) или fallback; совпадает с дефолтами env.schema.
 *
 * @param name - имя переменной
 * @param fallback - значение по умолчанию
 * @returns Число
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Опции Socket.IO gateway из env (зеркало Zod-схемы).
 *
 * Зачем: ping/namespace/buffer должны настраиваться без пересборки образа.
 * Как: читает process.env с теми же дефолтами, что `env.schema.ts`.
 *
 * @returns Опции для `@WebSocketGateway`
 */
export function buildNotificationsGatewayOptions(): {
  namespace: string;
  transports: Array<'websocket' | 'polling'>;
  pingInterval: number;
  pingTimeout: number;
  maxHttpBufferSize: number;
  cors: { origin: boolean };
} {
  return {
    namespace: process.env['WS_PATH'] ?? '/ws/notifications',
    transports: ['websocket', 'polling'],
    pingInterval: envInt('WS_PING_INTERVAL_MS', 25_000),
    pingTimeout: envInt('WS_PING_TIMEOUT_MS', 20_000),
    maxHttpBufferSize: envInt('WS_MAX_HTTP_BUFFER_SIZE', 1_000_000),
    cors: { origin: true },
  };
}
