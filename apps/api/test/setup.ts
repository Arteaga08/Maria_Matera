import { afterAll, afterEach, beforeAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

/**
 * Test bootstrap. Env vars must be set BEFORE any module that reads them
 * (`env.ts`) is imported by a test file. A fresh in-memory MongoDB backs every
 * run; collections are wiped between tests for isolation.
 */

process.env.NODE_ENV ??= "test";
process.env.JWT_ACCESS_SECRET ??= "test_access_secret_minimo_32_caracteres_aaaa";
process.env.JWT_REFRESH_SECRET ??= "test_refresh_secret_minimo_32_caracteres_bbbb";
process.env.ENCRYPTION_KEY ??= "test_encryption_key_minimo_32_caracteres_cccc";
process.env.CLIENT_URL ??= "http://localhost:3000";
process.env.APP_URL ??= "http://localhost:3000";
process.env.MONGO_URI ??= "mongodb://127.0.0.1:27017/placeholder";

// Replica set (single node) so multi-document transactions work in tests.
let mongo: MongoMemoryReplSet;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  // Pre-create collections + indexes so multi-document transactions never have
  // to implicitly create a collection (which would fail with a lock error).
  await Promise.all(
    mongoose.modelNames().map((name) => mongoose.model(name).createCollection()),
  );
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
