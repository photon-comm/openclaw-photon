// Photon tests cover the line step of the setup wizard.
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";

const provision = vi.hoisted(() => ({
  getPhotonImessageMode: vi.fn(),
  ensurePhotonSharedLine: vi.fn(),
  listPhotonDedicatedLines: vi.fn(),
}));

vi.mock("./provision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provision.js")>()),
  ...provision,
}));

const { preparePhotonLine } = await import("./setup-surface.js");

function prompter(answer: string) {
  const notes: string[] = [];
  const fake = {
    text: vi.fn(async () => answer),
    note: vi.fn(async (message: string) => {
      notes.push(message);
    }),
    progress: vi.fn(() => ({ update: () => {}, stop: () => {} })),
  };
  return { prompter: fake as unknown as WizardPrompter, notes };
}

const project = { projectId: "pho_prj_1", name: "OpenClaw" };

describe("preparePhotonLine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("assigns a shared line on a shared-line project", async () => {
    provision.getPhotonImessageMode.mockResolvedValue({ mode: "shared", maxUserAssignments: 25 });
    provision.ensurePhotonSharedLine.mockResolvedValue({ line: "+15550000001", created: true });
    const { prompter: p, notes } = prompter("+1 555 123 4567");
    const handle = await preparePhotonLine(p, "token", project);
    expect(handle).toBe("+15551234567");
    expect(provision.ensurePhotonSharedLine).toHaveBeenCalledWith("token", "pho_prj_1", "+15551234567");
    expect(notes[0]).toContain("+15550000001");
  });

  it("assigns nothing when the line settings can't be read", async () => {
    provision.getPhotonImessageMode.mockRejectedValue(new Error("Photon 503 BILLING_ENTITLEMENTS_PENDING"));
    const { prompter: p, notes } = prompter("+15551234567");
    const handle = await preparePhotonLine(p, "token", project);
    expect(handle).toBe("+15551234567");
    expect(provision.ensurePhotonSharedLine).not.toHaveBeenCalled();
    expect(notes[0]).toContain("Couldn't read this project's iMessage line settings");
  });
});
