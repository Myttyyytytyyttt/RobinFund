import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  agentVaultControllerArtifact,
  fundArtifact,
  vaultArtifactsContractSourceSha256,
  vaultArtifactsSourceSha256,
  type GeneratedVaultArtifact,
} from "../src/generated/vault-artifacts.js";
import { linkVaultArtifactBytecode } from "../src/vault-worker.js";

const navLib = "0x1234567890abcdef1234567890abcdef12345678" as Address;

function expectLinked(artifact: GeneratedVaultArtifact): void {
  const linked = linkVaultArtifactBytecode(artifact, navLib);
  expect(linked).toMatch(/^0x[0-9a-f]+$/);
  expect(linked).not.toContain("__$");

  let references = 0;
  for (const libraries of Object.values(artifact.bytecode.linkReferences)) {
    for (const [name, positions] of Object.entries(libraries)) {
      expect(name).toBe("NAVLib");
      for (const position of positions) {
        const start = 2 + position.start * 2;
        expect(linked.slice(start, start + position.length * 2)).toBe(navLib.slice(2));
        references += 1;
      }
    }
  }
  expect(references).toBeGreaterThan(0);
}

describe("generated vault deployment artifacts", () => {
  it("contains a reproducible source fingerprint", () => {
    expect(vaultArtifactsSourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(vaultArtifactsContractSourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fully links AgentVaultController and Fund to NAVLib", () => {
    expectLinked(agentVaultControllerArtifact);
    expectLinked(fundArtifact);
  });
});
