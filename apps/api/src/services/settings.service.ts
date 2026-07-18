import { Settings, SETTINGS_ID, type SettingsDocument } from "../models/Settings.js";
import { AppError } from "../utils/AppError.js";

/**
 * Store settings singleton read helper. There is intentionally no admin CRUD
 * yet for Settings (out of scope for Milestone 5 / Task 2 — flagged, not
 * assumed) — this is the only access point. `get()` upserts the single
 * document at the fixed `SETTINGS_ID`, race-safely: `findByIdAndUpdate` with
 * `upsert: true` relies on `_id`'s unique index, so two concurrent
 * first-callers can never create two documents (unlike a plain
 * `findOne() ?? create()`, which would). Callers (cart pricing) never have to
 * special-case "no settings document yet".
 */

const get = async (): Promise<SettingsDocument> => {
  const settings = await Settings.findByIdAndUpdate(
    SETTINGS_ID,
    {},
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  if (!settings) {
    // Unreachable in practice: `upsert: true` + `new: true` always returns
    // the (possibly just-created) document. Guarded only to avoid a
    // non-null assertion.
    throw new AppError("No se pudo cargar la configuración de la tienda.", 500);
  }
  return settings;
};

export { get };
