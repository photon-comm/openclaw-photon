# OpenClaw iMessage plugin by Photon

Text your [OpenClaw](https://github.com/openclaw/openclaw) agent from iMessage. This channel plugin connects OpenClaw to a [Photon](https://photon.codes) iMessage line: no Mac, no Apple ID to sign in, and no public URL or webhook. The gateway opens one outbound connection to Photon's event stream and receives messages over it, so it works on a laptop or a server behind NAT.

Since v0.2 the plugin runs on Photon Beta (2.0): the Photon API at `api.photon.codes`, a project ID (`pho_prj_...`) and a project API key (`pho_sk_...`). For Photon Stable (Spectrum project ID and secret), use [v0.1.1](https://github.com/photon-hq/openclaw-photon/tree/v0.1.1).

## Requirements

- OpenClaw 2026.11.3 or later
- Node.js 24 (the version OpenClaw itself needs)
- A Photon account at [app.beta.photon.codes](https://app.beta.photon.codes). Setup can create the project and the API key for you.

## Installation

```bash
openclaw plugins install git:github.com/photon-hq/openclaw-photon
```

OpenClaw asks two questions: whether to install a plugin that doesn't come from ClawHub, and whether to grant its capabilities (the Photon channel; no access to other conversations). Answer `y` to both. In a script, pass `--force --accept-capabilities` instead. To pin a release, add its tag: `git:github.com/photon-hq/openclaw-photon@v0.2.0`.

## Setup

Run the setup wizard:

```bash
openclaw configure --section channels
```

Choose **Photon (iMessage, no Mac)** from the channel list. The wizard:

1. **Signs you in to Photon.** It prints a link and a code; open the link on any device, sign in to Photon and confirm the code. Your password never goes into the terminal, and the sign-in isn't stored.
2. **Picks the project.** Choose one of your projects, or let it create a new one named "OpenClaw". With more than one organization, it asks which first.
3. **Creates an API key** for the gateway in that project, with `project:read`, `project:write` and `platforms:read`, and saves it in your OpenClaw config.
4. **Gives you a line.** Enter the phone number (like `+15551234567`) or iMessage email you will text from. On a shared-line project, Photon assigns that sender a line from its pool, and the wizard shows the number to text. On a project with dedicated lines, it shows the project's own line.

When you choose **Finished**, OpenClaw asks whether to configure DM access. Answer yes, pick **Allowlist** and keep your number, so only you can reach the agent. Otherwise the default is pairing (see [DM policy](#dm-policy)).

Already have a key? Skip the sign-in and enter the project ID from your project's Settings and an API key from its API keys page, or set `PHOTON_PROJECT_ID` and `PHOTON_API_KEY` in the gateway's environment. Without the wizard: `openclaw channels add --channel photon --project-id pho_prj_... --api-key pho_sk_...` saves the key in OpenClaw's secret store.

## Usage

Start the gateway:

```bash
openclaw gateway run
```

Then text the line the wizard showed you. Your message shows as read once the agent picks it up, and the typing indicator runs until the reply arrives in the same conversation. A shared line only answers: you text it first, and from then on the agent can write to you.

A message sent while the gateway is stopped still gets its answer. The gateway saves its place in Photon's event stream and resumes from there when it starts again, as far back as Photon still keeps the project's events.

## Configuration

After setup, `openclaw.json` holds:

```json
{
  "channels": {
    "photon": {
      "enabled": true,
      "projectId": "pho_prj_...",
      "apiKey": "pho_sk_...",
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    }
  }
}
```

`apiKey` also takes a SecretRef, for example `{ "source": "env", "provider": "default", "id": "PHOTON_API_KEY" }`, so the key stays out of the file.

| Key | What it does |
| --- | --- |
| `projectId` | Photon project ID (`pho_prj_...`). Falls back to `PHOTON_PROJECT_ID`. |
| `apiKey` | Project API key (`pho_sk_...`) with `project:read`, `project:write` and `platforms:read`, as a string or SecretRef. Falls back to `PHOTON_API_KEY`. |
| `dmPolicy` | Who can start a conversation: `pairing` (default), `allowlist`, `open` or `disabled`. |
| `allowFrom` | Phone numbers in E.164 form or iMessage emails. `open` needs `"*"` here. |
| `mediaMaxMb` | Largest attachment the agent receives or sends, in MB (default 20). |
| `markdown` | OpenClaw's usual markdown options. Photon sends iMessage text as plain text, so tables follow `markdown.tables` and other Markdown is removed. |

The gateway keeps its place in Photon's event stream, and the conversation it found for each sender, in `~/.openclaw/photon/<account>.json`.

### DM policy

- `pairing`: a new sender gets a pairing code, and you approve it with `openclaw pairing approve photon <code>`.
- `allowlist`: only senders in `allowFrom` reach the agent. Others get no reply, no read receipt and no typing indicator.
- `open`: anyone who texts the line reaches the agent. Requires `allowFrom: ["*"]`.
- `disabled`: no inbound messages.

### Targets

To send from the agent or the CLI, address a person by phone number or iMessage email, with or without the channel prefix:

- `photon:+15551234567`
- `+15551234567`
- `you@icloud.com`

For example: `openclaw message send --channel photon --target +15551234567 --media ./photo.png --message "Here it is"`. The image goes first and the text follows as its own bubble.

## Features

- Inbound over Photon's WebSocket event stream: no webhook, no tunnel, no open port
- Catch-up after a restart from the saved event cursor
- Setup wizard with Photon sign-in, project and API key creation, and line assignment
- Read receipts and the typing indicator while the agent works
- Images in both directions
- DM policy, allowlist and pairing

## Limits

- Photon Beta sends iMessage text and images. Tapbacks, voice notes and message effects are on Photon Stable only for now; Photon refuses a tapback with `422 UNSUPPORTED_CONTENT`, so the v0.1 `reactions` option is ignored.
- A shared line can't start a conversation. To have the agent write first, use a project with a dedicated line.
- Direct messages only. Messages in group chats are ignored.
- One Photon project per gateway.

### Upgrading from v0.1

v0.1 ran on Photon Stable with a Spectrum project ID and secret, which v0.2 can't use. Run `openclaw configure --section channels` again and sign in: setup saves a Beta project ID and API key and removes the old `projectSecret`. Until then, `openclaw channels status` shows the account as not configured and says why. To stay on Stable, install `git:github.com/photon-hq/openclaw-photon@v0.1.1`.

## Development

```bash
npm install
npm run check   # typecheck, tests and build
openclaw plugins install --link .   # load this checkout into a local OpenClaw
```

OpenClaw installs plugins from git without running build scripts, so the compiled `dist/` folder is committed. Run `npm run build` and commit `dist/` with every source change; CI fails when it is out of date.

`PHOTON_API_ORIGIN` points the plugin, setup included, at another Photon environment, such as `https://api.staging.photon.codes`.

### Releasing

1. Raise `version` in `package.json`, run `npm install --package-lock-only` and `npm run build`, and merge.
2. Publish a GitHub release tagged `v` plus that version (for example `v0.2.0`). The **Release to npm** workflow publishes it to npm.
3. Run **Release to ClawHub** with the same tag: `gh workflow run clawhub.yml -f tag=v0.2.0`.

## License

MIT
