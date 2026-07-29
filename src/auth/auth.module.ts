import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';

import { AppConfigService } from '../common/config/app-config.service.js';

import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { HttpAuthGuard } from './guards/http-auth.guard.js';
import { WsAuthGuard } from './guards/ws-auth.guard.js';
import { TokenVerifier } from './token-verifier.js';

/**
 * Модуль аутентификации (dev-JWT + глобальный HTTP-guard).
 *
 * Зачем: единый механизм для REST и (позже) WS.
 * Как: JwtModule с секретом/TTL из конфига; HttpAuthGuard как APP_GUARD.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): JwtModuleOptions =>
        ({
          secret: config.jwtSecret,
          // JWT_TTL — строка вида «24h» (совместима с jsonwebtoken / ms).
          signOptions: { expiresIn: config.jwtTtl },
        }) as JwtModuleOptions,
    }),
  ],
  controllers: [AuthController],
  providers: [
    TokenVerifier,
    AuthService,
    WsAuthGuard,
    { provide: APP_GUARD, useClass: HttpAuthGuard },
  ],
  exports: [TokenVerifier, AuthService, WsAuthGuard, JwtModule],
})
export class AuthModule {}
