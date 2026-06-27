import { afterAll, afterEach, beforeAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

/**
 * Test bootstrap. Env vars must be set BEFORE any module that reads them
 * (`env.ts`) is imported by a test file. A fresh in-memory MongoDB backs every
 * run; collections are wiped between tests for isolation.
 */

process.env.NODE_ENV ??= "test";
process.env.JWT_ACCESS_SECRET ??= "test_access_secret_minimo_32_caracteres_aaaa";
process.env.JWT_REFRESH_SECRET ??= "test_refresh_secret_minimo_32_caracteres_bbbb";
process.env.CLIENT_URL ??= "http://localhost:3000";
process.env.APP_URL ??= "http://localhost:3000";
process.env.MONGO_URI ??= "mongodb://127.0.0.1:27017/placeholder";

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  for (const key of Object.keys(collections)) {
    await collections[key]!.deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
