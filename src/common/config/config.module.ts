import { Global, Module } from '@nestjs/common';

import { AppConfigService } from './app-config.service.js';

/**
 * Глобальный модуль конфигурации.
 *
 * Зачем: AppConfigService нужен почти во всех модулях без повторного импорта.
 * Как: помечает модуль @Global и экспортирует единственный провайдер.
 */
@Global()
@Module({
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
