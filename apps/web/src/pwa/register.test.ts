// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./register.js";

const register = vi.fn(() => Promise.resolve());

afterEach(() => {
  register.mockClear();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

const withServiceWorkers = () => Object.defineProperty(navigator, "serviceWorker", { value: { register }, configurable: true });

describe("registerServiceWorker", () => {
  it("registers /sw.js once the page has loaded", () => {
    withServiceWorkers();

    registerServiceWorker(true);
    expect(register).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("load"));

    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("stays off in development", () => {
    withServiceWorkers();

    registerServiceWorker(false);
    window.dispatchEvent(new Event("load"));

    expect(register).not.toHaveBeenCalled();
  });
});
