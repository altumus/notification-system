/** @type {import('jest').Config} */
const tsJestTransform = {
  '^.+\\.ts$': [
    'ts-jest',
    {
      tsconfig: '<rootDir>/tsconfig.json',
    },
  ],
};

const moduleNameMapper = {
  '^@/(.*)$': '<rootDir>/src/$1',
  // NodeNext-импорты в исходниках оканчиваются на .js; в Jest резолвим в .ts.
  '^(\\.{1,2}/.*)\\.js$': '$1',
};

module.exports = {
  // Контейнер поднимается один раз в globalSetup; отдельным запросам к реальному Postgres
  // (в т.ч. первому — с холодным пулом) нужно больше времени, чем дефолтные 5 секунд Jest.
  testTimeout: 30_000,
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
      transform: tsJestTransform,
      moduleNameMapper,
      testEnvironment: 'node',
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
      transform: tsJestTransform,
      moduleNameMapper,
      testEnvironment: 'node',
      // Один контейнер Postgres на прогон: параллельные файлы ломают truncateAll друг другу.
      maxWorkers: 1,
      globalSetup: '<rootDir>/test/setup/global-setup.ts',
      globalTeardown: '<rootDir>/test/setup/global-teardown.ts',
    },
  ],
};
