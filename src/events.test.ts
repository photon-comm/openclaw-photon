// Photon tests cover the event subscription handshake.
import type { io } from "socket.io-client";
import { describe, expect, it, vi } from "vitest";
import { PHOTON_EVENTS_API_VERSION, subscribePhotonEvents } from "./events.js";

type Handler = (...args: unknown[]) => void;

function fakeSocket() {
  const handlers = new Map<string, Handler>();
  const emitted: Array<{ event: string; payload: unknown; ack: Handler }> = [];
  const socket = {
    connected: false,
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
      return socket;
    },
    timeout() {
      return {
        emit(event: string, payload: unknown, ack: Handler) {
          emitted.push({ event, payload, ack });
        },
      };
    },
    connect() {
      socket.connected = true;
      handlers.get("connect")?.();
      return socket;
    },
    disconnect() {
      socket.connected = false;
      return socket;
    },
    removeAllListeners() {
      handlers.clear();
      return socket;
    },
  };
  return { socket, emitted };
}

describe("subscribePhotonEvents", () => {
  it("subscribes from the saved cursor with the pinned payload version", () => {
    const { socket, emitted } = fakeSocket();
    const onSubscribed = vi.fn();
    const subscription = subscribePhotonEvents({
      origin: "https://api.test",
      projectId: "pho_prj_1",
      apiKey: "pho_sk_test",
      cursor: () => 42,
      onEvent: () => {},
      onSubscribed,
      log: () => {},
      connect: (() => socket) as unknown as typeof io,
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.event).toBe("subscribe");
    expect(emitted[0]?.payload).toEqual({ startSeq: 42, apiVersion: PHOTON_EVENTS_API_VERSION });

    emitted[0]?.ack(null, { ok: true, startSeq: 42, apiVersion: PHOTON_EVENTS_API_VERSION });
    expect(onSubscribed).toHaveBeenCalledWith(42);
    expect(subscription.isSubscribed()).toBe(true);
    subscription.stop();
  });
});
