# Changelog

## 0.2.3

- Attachments are downloaded only for a sender who may reach the agent. The gateway used to fetch and save a message's attachments before it checked `dmPolicy`, `allowFrom` and pairing approvals, so anyone who texted the line could make it download and store files. Now the check comes first. From a sender who isn't let in, nothing is downloaded or saved, the sender isn't added to the gateway's saved conversations, and under `pairing` they get only the pairing code. Allowed senders' messages, attachments included, reach the agent as before.
- The README's install section uses npm (`openclaw plugins install @photon-ai/openclaw`) and ClawHub (`clawhub:@photon-ai/openclaw`), with the GitHub install as an alternative.

## 0.2.2

- The package is published as `@photon-ai/openclaw` on npm and ClawHub, in place of `@photon-comm/openclaw-photon`, which was never published. The repository stays at github.com/photon-comm/openclaw-photon, and the plugin id stays `photon`, so `channels.photon` in `openclaw.json` is unchanged.

Earlier versions are described in the [GitHub releases](https://github.com/photon-comm/openclaw-photon/releases).
