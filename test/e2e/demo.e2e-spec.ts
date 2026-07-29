import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { closeE2eApp, createE2eApp } from '../setup/e2e-app';

describe('demo page e2e', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env['AUTH_DEV_TOKENS_ENABLED'] = 'true';
    const created = await createE2eApp();
    app = created.app;
  });

  afterAll(async () => {
    await closeE2eApp(app);
  });

  it('GET /demo/ отдаёт HTML без авторизации', async () => {
    const res = await request(app.getHttpServer()).get('/demo/').expect(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Notification System');
    expect(res.text).toContain('app.js');
  });

  it('GET /demo/app.js отдаёт скрипт без авторизации', async () => {
    const res = await request(app.getHttpServer()).get('/demo/app.js').expect(200);
    expect(res.text).toContain('loadSocketIo');
  });
});
