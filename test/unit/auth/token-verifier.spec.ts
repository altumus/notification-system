import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { TokenVerifier } from '@/auth/token-verifier';
import type { AppConfigService } from '@/common/config/app-config.service';

describe('TokenVerifier', () => {
  const secret = 'unit-test-jwt-secret-16';
  const config = { jwtSecret: secret } as AppConfigService;
  const jwtService = new JwtService({ secret });
  const verifier = new TokenVerifier(jwtService, config);

  it('issue + verify возвращает userId и role', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const token = await verifier.issueToken(userId, 'service');
    await expect(verifier.verify(token)).resolves.toEqual({ userId, role: 'service' });
  });

  it('просроченный токен → UnauthorizedException', async () => {
    const token = await jwtService.signAsync(
      { sub: '11111111-1111-4111-8111-111111111111', role: 'user' },
      { secret, expiresIn: 0 },
    );
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('битый payload → UnauthorizedException', async () => {
    const token = await jwtService.signAsync({ sub: '', role: 'admin' }, { secret });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
