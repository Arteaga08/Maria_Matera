import { Schema, model, models, type Model } from "mongoose";

/**
 * Atomic sequence counter keyed by an arbitrary string (e.g. a category SKU
 * prefix). `nextSequence` increments and returns the new value in one atomic
 * operation, so concurrent callers never get duplicates.
 */

interface CounterDocument {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<CounterDocument>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false },
);

const Counter: Model<CounterDocument> =
  (models.Counter as Model<CounterDocument>) ??
  model<CounterDocument>("Counter", counterSchema);

const nextSequence = async (key: string): Promise<number> => {
  const counter = await Counter.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return counter.seq;
};

export { Counter, nextSequence };
