import { expect, it } from "vitest";
import { addToast, type Toast } from "./toast-state";

it("deduplicates active keys and caps the visible stack", () => {
  const first = { id: "1", key: "save", type: "success" as const, message: "Saved" };
  expect(addToast([first], { ...first, id: "2" })).toEqual([first]);
  let stack: Toast[] = [first];
  for (let i = 2; i <= 6; i++) stack = addToast(stack, { ...first, id: String(i), key: String(i) });
  expect(stack.map(t => t.id)).toEqual(["4", "5", "6"]);
});
