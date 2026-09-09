import { defineConfig } from 'prisma/config';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '.env') });

const DEFAULT_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/statusbus?schema=public';

export default defineConfig({
  schema: path.resolve(__dirname, 'prisma/schema.prisma'),
  migrations: {
    path: path.resolve(__dirname, 'prisma/migrations')
  },
  datasource: {
    url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  }
});