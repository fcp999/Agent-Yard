# Agent Yard

A local-first multi-agent workbench. It talks directly to an Ollama service; there is no Agent Yard account, OAuth flow, analytics, package dependency, or third-party font/CDN request.

## Run it

Requires Node.js 20 or newer. No `npm install` is needed.

```sh
npm start
```

Open <http://127.0.0.1:4173>. The default Ollama address is `http://127.0.0.1:11434`. Change it with the gear button if the Ollama service is elsewhere. Agent Yard is a browser app and runs headless; it needs no VNC, X server, or desktop session.

By default, it binds to loopback so only a browser on the same machine can connect. To run it on a headless Linux host and open it from another machine on your trusted LAN:

```sh
HOST=0.0.0.0 npm start
```

Then open `http://<server-lan-ip>:4173` in your browser. Set `PORT` to change the port. Keep the host behind a trusted LAN or firewall; this first version has no user login.

The Ollama host must be reachable from the machine running Agent Yard. For a remote Ollama host, its service needs to accept connections from this machine. The app itself does not configure Ollama or expose Ollama to the network.

## How missions work

Choose a crew preset, write a mission brief, and pick models. The three role agents work independently in parallel. The Coordinator then reconciles their answers into one practical response. Presets cover general work, software builds, troubleshooting, and research.

The page shows live agent status and lets you cancel a long run. When a run finishes, ask up to three follow-up rounds. Export the full mission and its answers as Markdown. Recent missions, connection settings, and per-role model choices are saved in `data/` beside the app. Clear history from the UI at any time.

No prompt is sent anywhere except the Ollama endpoint you configured. Agent Yard does not sign in to provider accounts. Agents plan and review; they do not edit files, run shell commands, or stay running as background workers.

## Test

```sh
npm test
```

## Configuration

The endpoint can be an Ollama server. Models are discovered from `/api/tags`; chat uses `/api/chat`. The settings API also accepts a model timeout from 20 to 600 seconds.

## Phase 2: mission workspaces (experimental)

Each created mission now owns a directory under `data/workspaces/<mission-id>/`. Open a mission debrief and use **Mission workspace** to list/read files, propose text-file writes, or propose a permitted command. Proposed actions **never execute until you click Approve**. The Reject button records a rejection. Action decisions are appended to `data/workspace-audit.jsonl`.

Allowed commands: `node --test`, `npm test`, `git status --short`, and `git diff --`. Commands run without a shell, in the mission directory, with a 30-second deadline and 256 KB process-output limit. Commands such as `npm test` execute code and should only be approved for trusted workspace content. No arbitrary command or Git push capability is exposed.

### Workspace API

- `GET /api/runs/:id/workspace` returns files and approval tickets.
- `GET /api/runs/:id/workspace/file?path=src/file.txt` reads a text file.
- `POST /api/runs/:id/workspace/actions` accepts `{"action":"write","path":"src/file.txt","content":"hello"}` or `{"action":"command","command":"node-test"}`.
- `POST /api/runs/:id/workspace/approvals/:ticketId` accepts `{"approve":true}` or `{"approve":false}`.

**Scope/limitations:** This is an approval-gated human-operated workspace, not yet an autonomous agent tool loop. Approval tickets are in memory and expire on server restart. The audit log and written files persist. In-progress model calls are marked interrupted after restart, not automatically resumed. No OS/container isolation is provided: execute only trusted code, use a dedicated unprivileged account, and **do not expose the server to untrusted networks**. A future stage should add container execution isolation and AI-proposed tool actions.
