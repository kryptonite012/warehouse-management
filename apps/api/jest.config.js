module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
  globalSetup: '<rootDir>/test/global-setup.js',
  setupFiles: ['<rootDir>/test/setup-env.js'],
  testTimeout: 30000,
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true }] },
};
