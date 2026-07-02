import { connectDatabase, disconnectDatabase } from "../config/db.js";
import { logger } from "../config/logger.js";
import { seedCategories } from "./categories.seed.js";

/**
 * Seed runner: `pnpm --filter @maria-matera/api seed`. Connects, seeds base
 * data, disconnects. Idempotent.
 */

const run = async (): Promise<void> => {
  await connectDatabase();
  const count = await seedCategories();
  logger.info(`Seed completado: ${count} categorías base.`);
  await disconnectDatabase();
};

run().catch((error: unknown) => {
  logger.error({ err: error }, "Fallo el seed");
  process.exit(1);
});
