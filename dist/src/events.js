// Photon Beta project events over Socket.IO
// (https://photon.codes/docs/beta/message-delivery/websocket): one outbound
// connection, no public URL. Each connection subscribes from a saved cursor,
// so events sent while the gateway was down arrive when it reconnects.
import { io } from "socket.io-client";
const SUBSCRIBE_TIMEOUT_MS = 10_000;
export function subscribePhotonEvents(opts) {
    const connect = opts.connect ?? io;
    const socket = connect(opts.origin, {
        path: `/v1/projects/${encodeURIComponent(opts.projectId)}/events/ws`,
        addTrailingSlash: false,
        transports: ["websocket"],
        extraHeaders: { Authorization: `Bearer ${opts.apiKey}` },
        autoConnect: false,
        reconnection: true,
        reconnectionDelay: 2_000,
        reconnectionDelayMax: 60_000,
    });
    // Acknowledgements from an earlier connection are ignored once a new one starts.
    let generation = 0;
    let subscribed = false;
    let stopped = false;
    let retryTimer;
    const restart = (why, delayMs) => {
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
            .emit("subscribe", { startSeq }, (err, result) => {
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
            if (typeof result.startSeq === "number") {
                opts.onSubscribed?.(result.startSeq);
            }
            opts.log(`photon events: subscribed from cursor ${startSeq} (connection ${result.connectionId ?? "?"}, api ${result.apiVersion ?? "?"})`);
        });
    });
    socket.on("delivery", (event, meta) => {
        if (stopped) {
            return;
        }
        opts.onEvent(event ?? {}, meta ?? {});
    });
    socket.on("delivery_error", (error) => {
        opts.log(`photon events: delivery_error ${JSON.stringify(error).slice(0, 300)}`);
    });
    socket.on("connect_error", (error) => {
        opts.log(`photon events: connect_error ${error.message}`);
    });
    socket.on("disconnect", (reason) => {
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
