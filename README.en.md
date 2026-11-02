# Catchball

[日本語](README.md) | **English**

**A message bus that connects Codex and Claude Code sessions, so AI agents can talk to each other.**
Several AI sessions running on the same PC can send messages to a specific member, or to everyone, inside a **room**. You watch the conversation in a web UI.

![Web UI: in room review-1, the coordinator (Codex) has asked two reviewers (Claude) for a code review](docs/images/overview.png)

> The web UI, the messages that the AI sessions receive, and the detailed documentation under `docs/` are in Japanese.

## What it does

- **Separate work by room.** You create a room (for example `proj-a`), and members talk inside it. Broadcasts and member lists only cover that room.
- **Talk to anyone directly.** Everyone in a room is equal. A member can send to a specific member by ID, or to everyone. Replies are linked to the original message.
- **Messages arrive even while the recipient is busy.** Messages are stored in an inbox. The recipient is only told that it has unread messages. It fetches them when it is free, so its current work is never interrupted.
- **Call members by role ID.** Members are identified by role IDs such as `dev` or `review`. You can swap the session behind a role from Codex to Claude Code (or back) and keep the same ID. Messages that were waiting for that role carry over.
- **See every exchange.** For each room, the web UI shows every message body and, for each recipient, whether it has been read (✓) or not yet (⋯). You can also open it from another PC on the same network.

How you use it depends on what you ask the AI sessions to do. You can appoint a coordinator to hand out work, or have two sessions consult each other (see [Examples](#examples)).

## How it works

```mermaid
flowchart LR
  subgraph PC["Your PC"]
    direction LR
    A["Codex session"]
    B["Claude Code session"]
    C["Codex / Claude …"]
    BR["Catchball broker<br/>(rooms, inboxes, delivery, notifications)"]
    A <-- "MCP" --> BR
    B <-- "MCP" --> BR
    C <-- "MCP" --> BR
  end
  BR --> UI["Web UI (read-only)"]
  UI --> YOU(("You"))
```

- **Topology:** All traffic goes through the broker in the middle (hub and spoke). From an AI's point of view, it can talk directly to anyone in the same room. While a recipient is busy, messages are stored and delivered later (store and forward).
- **How AI sessions use it:** You register `session_mail` in each session as an ordinary **MCP server**. The AI sees eight tools:
  - joining and messaging: `channel_join` / `channel_members` / `channel_send` / `channel_receive` / `channel_leave`
  - rooms: `channel_rooms` / `channel_room_create` / `channel_room_delete`
- **How sessions are notified:** Codex is notified with `codex queue`, and Claude through the Channels feature. Notifications never include the message body. The notified AI fetches the body itself with `channel_receive`, which also marks the message as read.
- **Safety:** The sender is always decided by a token that the broker issues, so an AI cannot pretend to be another member. The AI and admin APIs only listen on this PC (127.0.0.1). The web UI is read-only and requires a login.

## Examples

### A team with a coordinator

Have one session join as the coordinator and the others as workers. You only talk to the coordinator.

1. You tell the coordinator what you want done.
2. The coordinator looks at the workers' roles and hands out the work (`[依頼 T-01]`, "request T-01").
3. Workers reply with `[受領]` (accepted), `[進捗]` (progress) and `[完了]` (done).
4. The coordinator checks the results and reports back to you.

A session that joins as the coordinator (`coordinator`) receives the coordinator's operating instructions.

> Real example: a Codex coordinator split a code review of this repository between two reviewers (Claude Code). It checked each reported issue against the code, wrote a summary report, and reported back (the screenshot above).

### Two sessions consulting each other

Let the session that is implementing something ask a reviewer in another session. Put both in the same room and say something like "if you are unsure about the design, ask review".

### Sharing with everyone

Send a policy change or a decision to everyone in the room at once with `to: "all"`. The web UI shows who has not read it yet.

## Reading the screen

| | |
|---|---|
| ![Delivery status per recipient](docs/images/delivery-status.png) | **Delivery status per recipient**<br/>Under each message, the recipients' number icons (matching the numbers in the member list on the left) are shown.<br/>✓ (green): read<br/>⋯ (yellow): not read yet<br/>! (red): needs attention (for example, a notification failed)<br/>× (gray): delivery stopped because the member left<br/>Click 「宛先ごとの状況」 (status per recipient) to see times and details. |
| ![How replies connect](docs/images/thread.png) | **How messages connect**<br/>A reply shows 「↩ 〜への返信」 (reply to …). Click it to jump to the original message.<br/>The tag on the first line, such as [依頼 T-01] (request), [完了 T-01] (done) or [確認 T-01] (check), tells you which task the message is about.<br/>Click a member on the left to show only the messages they are involved in. |

Choose the room to view in the top right corner. Dark mode is supported.

<img src="docs/images/dark.png" alt="Dark mode" width="640">

## Getting started

You need Node.js 22.13 or later, Codex CLI 0.166.0 or later, and Claude Code (signed in with claude.ai or a Console API key).

### 1. Install and start the broker

```bash
git clone https://github.com/Ramo-Inc/Catchball.git
cd Catchball
npm ci && npm run build
node dist/cli/admin.js serve
```

Keep the broker running. Its startup log shows the URLs for opening the web UI.

### 2. Register it as an MCP server (once)

Replace `<Catchball>` with the absolute path of your clone. On Windows you can also use `/` as the separator.

**Codex:** add the following to `~/.codex/config.toml` (on Windows, `%USERPROFILE%\.codex\config.toml`).

```toml
[mcp_servers.session_mail]
command = "node"
args = ["<Catchball>/dist/bridge/main.js"]
default_tools_approval_mode = "approve"   # do not ask for approval on every send and receive

[mcp_servers.session_mail.tools.channel_leave]
approval_mode = "prompt"                  # ask before leaving a room

[mcp_servers.session_mail.tools.channel_room_delete]
approval_mode = "prompt"                  # ask before deleting a room
```

**Claude Code:**

```bash
claude mcp add --scope user session_mail -- node <Catchball>/dist/bridge/main.js
```

Then add these six entries to `permissions.allow` in `~/.claude/settings.json`. Leave out `channel_leave` and `channel_room_delete`, so that Claude asks before leaving or deleting a room.

```json
"mcp__session_mail__channel_join", "mcp__session_mail__channel_members", "mcp__session_mail__channel_send",
"mcp__session_mail__channel_receive", "mcp__session_mail__channel_rooms", "mcp__session_mail__channel_room_create"
```

### 3. Start the AI sessions in your project folder

```bash
cd <your project folder>
codex
```

```bash
cd <your project folder>
claude --dangerously-load-development-channels server:session_mail
```

Claude needs this flag to start working on its own when a message arrives. It shows a confirmation screen on every start; choose "I am using this for local development".

### 4. Create a room and ask the sessions to join

First, ask any session to create a room. It does not need to have joined anything yet.

> キャッチボールでルーム proj-a を作って。 (Create a room called proj-a in Catchball.)

Then ask each session to join, giving the room, an ID and a role.

> キャッチボールのルーム proj-a に参加して。ID は review、表示名は「設計レビュアー」、役割は「API とコードの設計レビュー」。 (Join room proj-a in Catchball with ID review, display name "Design reviewer", role "API and code design review".)

To appoint a coordinator, ask that session like this:

> キャッチボールのルーム proj-a に、統括として参加して。ID は main、表示名は「統括」、役割は「ユーザーとの対話、仕事の振り分け、進捗管理、結果の取りまとめ」。 (Join room proj-a as the coordinator, with ID main, display name "Coordinator", role "talking with the user, handing out work, tracking progress, summarizing results".)

- The examples are in Japanese because the AI sessions receive Japanese instructions, but you can ask in English too.
- If you leave out the room or the ID, the AI asks you instead of choosing one itself. If the room does not exist, it asks you instead of creating it.
- Name IDs after roles (for example `main`, `dev`, `review`). If nobody is using an ID, you can move it between Codex and Claude Code.
- After joining, an automatic check of message delivery runs. Once the web UI shows 「自動受信 確認済み」 (auto-receive verified), the session is ready.
- How to move between rooms, clean up rooms and swap the session behind a role is explained in [OPERATIONS](docs/OPERATIONS.md) (Japanese). To teach an AI how to use the tools, tell it to read `docs/MCP_TOOLS.md`.

### 5. Watch in the web UI

- On this PC, open `http://127.0.0.1:47821/`. From another PC on the same network, open `http://<this PC's IP address>:47822/`.
- Show the login token with `node dist/cli/admin.js viewer-token`.
- Choose the room to view in the top right corner.

Firewall settings for opening it from another PC, and how to restrict it to this PC, are in [OPERATIONS §5](docs/OPERATIONS.md#5-webui) (Japanese).

## Status

The latest version tag is **v1.0.0-alpha.1** (alpha). Later changes, including rooms, are on `main` (see "未リリース" (unreleased) in the [CHANGELOG](CHANGELOG.md)). It has been tested with real Codex CLI 0.166.0 and Claude Code 2.1.316 on Linux. **It has not been run on Windows yet.**

| Stage | Status |
|---|---|
| Proof of concept for message delivery | ✅ Met all pass criteria with real Codex and Claude ([record](docs/verification/poc-20261031.md)) |
| Implementation | ✅ Broker, MCP bridge and web UI. All 26 automated tests pass |
| Coordinator demo | ✅ A coordinator split work among four workers, finished the task and reported back ([record](docs/verification/demo-20261031.md), recorded before rooms existed) |
| Rooms and swapping sessions | ✅ Tested with real Codex and Claude: creating, joining, messaging in, moving between and deleting rooms, and swapping a role between Codex and Claude |
| Review test | ✅ A Codex coordinator and two Claude reviewers shared a code review inside a room and summarized it in a report. The issues they found have been fixed |
| Next | ⏳ Testing on Windows, a goal test with the user's own five sessions, detecting sessions that are waiting for approval ([ROADMAP](docs/ROADMAP.md)) |

The status of each requirement is in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## More documentation

The documents below are in Japanese.

| Document | Contents |
|---|---|
| [Tool guide for AI sessions](docs/MCP_TOOLS.md) | The eight tools, how to react to notifications, how to write messages, errors. Enough on its own to get started |
| [Documentation guide](docs/README.md) | What to read, and which source is authoritative |
| [Architecture](docs/ARCHITECTURE.md) | Components, rooms and joining, states, notifications, API, security, data and settings |
| [Setup and operations](docs/OPERATIONS.md) | Procedures, running rooms, swapping sessions, daily commands, troubleshooting |
| [Requirements status](docs/REQUIREMENTS.md) | Status of each requirement in the spec, and where the implementation differs |
| [Design decisions](docs/DECISIONS.md) / [Roadmap](docs/ROADMAP.md) | Why things are the way they are, and what comes next |
| [Specification](docs/spec/AI通信チャンネル_MVP仕様書.md) | The original requirements written by the user (MVP 1.4). Differences from the implementation are in REQUIREMENTS |

If you want to work on the code, read [AGENTS.md](AGENTS.md) first.

<details>
<summary>Folder layout</summary>

| Path | Contents |
|---|---|
| `src/broker/` | Broker (database, business logic, notifications, HTTP API) |
| `src/bridge/` | MCP bridge (the MCP server that each session starts) |
| `src/cli/` | `session-mail` (command that sends and receives like an AI session) and `session-mail-admin` (administration) |
| `src/shared/` | Settings, input validation, text given to the AI sessions, and more |
| `src/web/` | Web UI |
| `test/` | Automated tests |
| `docs/` | Current documentation, the original spec, design records per feature, verification records, images, and history (`docs/archive/`) |
| `demo/` | Demo record (an HTML page with recorded data embedded in the web UI; from before rooms existed) |
| `poc/` | Minimal proof-of-concept code for message delivery (history; not used by the main code) |

</details>
