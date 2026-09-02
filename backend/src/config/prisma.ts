import { PrismaClient } from '@prisma/client';

// Lazily instantiated so importing this module (or anything that transitively
// imports it) never triggers PrismaClient construction unless the client is
// actually needed. This keeps unit/integration tests that inject their own
// mocked container fast and independent of a generated Prisma client / live DB.
let client: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!client) {
    client = new PrismaClient();
  }
  return client;
}
