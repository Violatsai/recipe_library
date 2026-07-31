import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { EnrichmentData } from "../src/ingest/enrich.js";
import {
  persistRecipesAtomically,
  type PersistRecipeInput,
  type RecipePersistenceDependencies,
} from "../src/ingest/pipeline.js";

function enrichment(title: string): EnrichmentData {
  return {
    title,
    servings: 2,
    total_time_min: 20,
    steps: ["Cook it."],
    ingredients: [{ name: "eggplant", quantity: 1, unit: null, raw_text: "1 eggplant" }],
    defining_ingredients: ["eggplant"],
    tags: { cuisine: [], dish_type: [], dietary: [] },
    new_tags: [],
    macros_per_serving: null,
    partial: false,
    source_used: null,
  };
}

function input(title: string, index: number): PersistRecipeInput {
  return {
    normalizedUrl: `https://example.com/roundup#${index}`,
    source: "web",
    resolveSourceDetail: () => null,
    data: enrichment(title),
    description: "captured source",
  };
}

describe("persistRecipesAtomically", () => {
  it("embeds every recipe before opening the single persistence transaction", async () => {
    const events: string[] = [];
    let recipeIndex = 0;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO recipes")) {
          recipeIndex++;
          return { rows: [{ id: `recipe-${recipeIndex}`, inserted: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    } as unknown as PoolClient;
    const embed = vi.fn(async () => {
      events.push("embed");
      return [0.1, 0.2];
    });
    let transactionCalls = 0;
    const transaction: RecipePersistenceDependencies["transaction"] = async (fn) => {
      transactionCalls++;
      events.push("transaction");
      return fn(client);
    };

    const results = await persistRecipesAtomically(
      [input("First", 0), input("Second", 1)],
      { embed, transaction },
    );

    expect(events).toEqual(["embed", "embed", "transaction"]);
    expect(transactionCalls).toBe(1);
    expect(results.map((item) => item.recipeId)).toEqual(["recipe-1", "recipe-2"]);
  });

  it("does not open a database transaction when any embedding fails", async () => {
    const embed = vi.fn()
      .mockResolvedValueOnce([0.1])
      .mockRejectedValueOnce(new Error("embedding failed"));
    let transactionCalls = 0;
    const transaction: RecipePersistenceDependencies["transaction"] = async () => {
      transactionCalls++;
      throw new Error("transaction should not run");
    };

    await expect(
      persistRecipesAtomically(
        [input("First", 0), input("Second", 1)],
        { embed, transaction },
      ),
    ).rejects.toThrow("embedding failed");
    expect(transactionCalls).toBe(0);
  });
});
