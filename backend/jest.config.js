/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/tests/**/*.test.ts'],
  clearMocks: true,
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 15000,
  forceExit: true
};
