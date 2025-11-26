import { defineConfig } from 'prisma/config';
import path from 'path';

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable must be set for Prisma migrations.");
}

export default defineConfig({
  schema: path.resolve(__dirname, 'prisma/schema.prisma'),
  migrations: {
    path: path.resolve(__dirname, 'prisma/migrations')
  },
  datasource: {
    url: process.env.DATABASE_URL
  }
});
