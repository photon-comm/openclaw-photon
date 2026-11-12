// Photon Beta project events over Socket.IO
// (https://photon.codes/docs/beta/message-delivery/websocket): one outbound
// connection, no public URL. Each connection subscribes from a saved cursor,
// so events sent while the gateway was down arrive when it reconnects.
import { io, type Socket } from "socket.io-client";

export type PhotonEvent = {
  id?: string;
  type?: string;
  data?: { object?: unknown; projectId?: string };
};

export type PhotonDeliveryMeta = { seq?: number; replyExpected?: boolean };

export type PhotonEventSubscription = {
  stop: () => void;
  isSubscribed: () => boolean;
};

export type PhotonEventSubscriptionOptions = {
  origin: string;
  projectId: string;
  apiKey: string;
  /** Last fully handled cursor; 0 means "new events only". */
  cursor: () => number;
  /** Called in delivery order; must not throw. */
  onEvent: (event: PhotonEvent, meta: PhotonDeliveryMeta) => void;
  log: (message: string) => void;
  /** Socket factory, for tests. */
  connect?: typeof io;
};

const SUBSCRIBE_TIMEOUT_MS = 10_000;

export function subscribePhotonEvents(opts: PhotonEventSubscriptionOptions): PhotonEventSubscription {
  const connect = opts.connect ?? io;
  const socket: Socket = connect(opts.origin, {
    path: `/v1/projects/${encodeURIComponent(opts.projectId)}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
    extraHeaders: { Authorization: `Bearer ${opts.apiKey}` },
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 2_000,
    reconnectionDelayMax: 60_000,
  });
  // Deliveries from an earlier connection are dropped once a new one starts.
  let generation = 0;
  let subscribed = false;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const restart = (why: string, delayMs: number) => {
    if (stopped) {
      return;
    }
    opts.log(`photon events: ${why}; reconnecting in ${Math.round(delayMs / 1000)}s`);
    generation += 1;
    subscribed = false;
    socket.disconnect();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (!stopped) {
        socket.connect();
      }
    }, delayMs);
  };

  socket.on("connect", () => {
    generation += 1;
    const current = generation;
    const startSeq = opts.cursor();
    socket
      .timeout(SUBSCRIBE_TIMEOUT_MS)
      .emit(
        "subscribe",
        { startSeq },
        (err: unknown, result: { ok?: boolean; error?: unknown; connectionId?: string; apiVersion?: string }) => {
          if (current !== generation || stopped) {
            return;
          }
          if (err) {
            restart("subscribe timed out", 5_000);
            return;
          }
          if (!result?.ok) {
            restart(`subscribe refused: ${JSON.stringify(result?.error ?? result).slice(0, 300)}`, 30_000);
            return;
          }
          subscribed = true;
          opts.log(
            `photon events: subscribed from cursor ${startSeq} (connection ${result.connectionId ?? "?"}, api ${result.apiVersion ?? "?"})`,
          );
        },
      );
  });

  socket.on("delivery", (event: PhotonEvent, meta: PhotonDeliveryMeta) => {
    if (stopped) {
      return;
    }
    opts.onEvent(event ?? {}, meta ?? {});
  });

  socket.on("delivery_error", (error: unknown) => {
    opts.log(`photon events: delivery_error ${JSON.stringify(error).slice(0, 300)}`);
  });
  socket.on("connect_error", (error: Error) => {
    opts.log(`photon events: connect_error ${error.message}`);
  });
  socket.on("disconnect", (reason: string) => {
    subscribed = false;
    if (stopped) {
      return;
    }
    opts.log(`photon events: disconnected (${reason})`);
    // Socket.IO doesn't reconnect after the server closes the connection.
    if (reason === "io server disconnect") {
      restart("server closed the connection", 10_000);
    }
  });

  socket.connect();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(retryTimer);
      socket.removeAllListeners();
      socket.disconnect();
    },
    isSubscribed: () => socket.connected && subscribed,
  };
}
