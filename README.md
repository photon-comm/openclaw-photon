# OpenClaw iMessage plugin by Photon

Text your [OpenClaw](https://github.com/openclaw/openclaw) agent from iMessage. This channel plugin connects OpenClaw to a [Photon](https://photon.codes) iMessage line: no Mac, no Apple ID to sign in, and no public URL or webhook. The gateway opens one outbound connection to Photon Spectrum and receives messages over it, so it works on a laptop or a server behind NAT.

## Requirements

- OpenClaw 2026.11.3 or later
- Node.js 24 (the version OpenClaw itself needs)
- A Photon account at [app.photon.codes](https://app.photon.codes). Setup can create the project for you.

## Installation

```bash
openclaw plugins install git:github.com/photon-hq/openclaw-photon
```

OpenClaw asks two questions: whether to install a plugin that doesn't come from ClawHub, and whether to grant its capabilities (the Photon channel; no access to other conversations). Answer `y` to both. In a script, pass `--force --accept-capabilities` instead. To pin a release, add its tag: `git:github.com/photon-hq/openclaw-photon@v0.1.0`.

## Setup

Run the setup wizard:

```bash
openclaw configure --section channels
```

Choose **Photon (iMessage, no Mac)** from the channel list. The wizard:

1. **Signs you in to Photon.** It prints a link and a code; open the link on any device, sign in to Photon and approve. Your password never goes into the terminal.
2. **Prepares a project.** It finds or creates a Photon project named "OpenClaw" and reads its Spectrum project ID and secret into your OpenClaw config.
3. **Adds your phone number.** Enter the number you will text from (like `+15551234567`). Photon assigns that number an iMessage line, and the wizard shows the line to text.

When you choose **Finished**, OpenClaw asks whether to configure DM access. Answer yes, pick **Allowlist** and keep your number, so only you can reach the agent. Otherwise the default is pairing (see [DM policy](#dm-policy)).

Already have a Photon project? Skip the sign-in and enter its project ID and secret from the project's Settings page, or set `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET` in the gateway's environment.

## Usage

Start the gateway:

```bash
openclaw gateway run
```

Then text the line the wizard showed you. The agent replies in the same conversation.

## Configuration

After setup, `openclaw.json` holds:

```json
{
  "channels": {
    "photon": {
      "enabled": true,
      "projectId": "your-spectrum-project-id",
      "projectSecret": "your-spectrum-project-secret",
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    }
  }
}
```

`projectSecret` also takes a SecretRef, for example `{ "source": "env", "provider": "default", "id": "PHOTON_PROJECT_SECRET" }`, so the secret stays out of the file.

| Key | What it does |
| --- | --- |
| `projectId` | Spectrum project ID. Falls back to `PHOTON_PROJECT_ID`. |
| `projectSecret` | Spectrum project secret, as a string or SecretRef. Falls back to `PHOTON_PROJECT_SECRET`. |
| `dmPolicy` | Who can start a conversation: `pairing` (default), `allowlist`, `open` or `disabled`. |
| `allowFrom` | Phone numbers in E.164 form. `open` needs `"*"` here. |
| `reactions` | `true` to tapback each message while the agent works: 👀, then 👍 or 👎. Also passes tapbacks on the agent's own messages to the agent. Off by default. |
| `mediaMaxMb` | Largest inbound attachment the agent receives, in MB (default 20). |
| `markdown` | OpenClaw's usual markdown options, such as table rendering. |

### DM policy

- `pairing`: a new sender gets a pairing code, and you approve it with `openclaw pairing approve photon <code>`.
- `allowlist`: only numbers in `allowFrom` reach the agent.
- `open`: anyone who texts the line reaches the agent. Requires `allowFrom: ["*"]`.
- `disabled`: no inbound messages.

### Targets

To send from the agent or the CLI, address a person by phone number, with or without the channel prefix:

- `photon:+15551234567`
- `+15551234567`

## Features

- Inbound over Photon Spectrum's streaming connection: no webhook, no tunnel, no open port
- Setup wizard with Photon sign-in, project creation and line assignment
- Typing indicator while the agent works
- Optional status tapbacks (`reactions`)
- Photos and files in both directions
- DM policy, allowlist and pairing

## Limits

- Direct messages only. Messages in group chats are ignored.
- One Photon project per gateway.
- Uses Photon's Stable platform (Spectrum, `spectrum-ts`). Photon's Beta API keys don't work here.

## Development

```bash
npm install
npm run check   # typecheck, tests and build
openclaw plugins install --link .   # load this checkout into a local OpenClaw
```

OpenClaw installs plugins from git without running build scripts, so the compiled `dist/` folder is committed. Run `npm run build` and commit `dist/` with every source change; CI fails when it is out of date.

## License

MIT
