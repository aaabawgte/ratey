import { describe, expect, it } from "vitest";
import { placeAverage, ratingAverage, type Rating } from "./lib";
const rating = (
  user_id: string,
  service: number,
  food: number | null,
  visit_id = "v1",
): Rating => ({
  visit_id,
  place_id: "p",
  user_id,
  service,
  ambience: 8,
  value: 8,
  location: 8,
  food,
  updated_at: "",
});
describe("zajedničke ocjene", () => {
  it("računa 9 i 7 kao 8", () =>
    expect(
      ratingAverage([rating("a", 9, null), rating("b", 7, null)], "service"),
    ).toBe(8));
  it("izostavlja hranu koju nitko nije probao", () =>
    expect(placeAverage([rating("a", 8, null), rating("b", 8, null)])).toBe(8));
  it("računa hranu samo od osobe koja ju je ocijenila", () =>
    expect(
      ratingAverage([rating("a", 8, 9.5), rating("b", 8, null)], "food"),
    ).toBe(9.5));
  it("privremena ocjena koristi dostupnu osobu", () =>
    expect(placeAverage([rating("a", 9, 7)])).toBe(8));
  it("svaku posjetu jednako uključuje u prosjek mjesta", () =>
    expect(
      ratingAverage(
        [
          rating("a", 9, null, "v1"),
          rating("b", 7, null, "v1"),
          rating("a", 10, null, "v2"),
        ],
        "service",
      ),
    ).toBe(9));
});
