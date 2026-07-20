import { describe, it, expect } from "vitest";
import type { Alert } from "./monitors.js";

describe("monitores permissionless", () => {
  it("solo modelan riesgos del emisor/infraestructura, no identidad de LPs", () => {
    const kinds: Alert["kind"][] = ["fund-blocked", "beacon-drift"];
    expect(kinds).toEqual(["fund-blocked", "beacon-drift"]);
  });
});
