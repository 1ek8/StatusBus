import { defineConfig, env } from 'prisma/config';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '.env') });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable must be set for Prisma migrations.");
}

export default defineConfig({
  schema: path.resolve(__dirname, 'packages/store/prisma/schema.prisma'),
  migrations: {
    path: path.resolve(__dirname, 'packages/store/prisma/migrations')
  },
  datasource: {
    url: env('DATABASE_URL')
  }
});
