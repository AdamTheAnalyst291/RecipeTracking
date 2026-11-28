// @vitest-environment jsdom
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";
import { describe, expect, it, vi } from "vitest";
import page from "../redirect.html?raw";

vi.mock("@azure/msal-browser/redirect-bridge", () => ({ broadcastResponseToMainFrame: vi.fn(() => Promise.resolve()) }));

describe("redirect bridge page", () => {
  it("hands Microsoft's answer back to the app that asked for it", async () => {
    await import("./redirectBridge.js");

    expect(broadcastResponseToMainFrame).toHaveBeenCalledOnce();
  });

  it("runs only the bridge, never the app, so the app's MSAL can't take the answer first", () => {
    const scripts = [...page.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1]);

    expect(scripts).toEqual(["/src/redirectBridge.ts"]);
  });
});
