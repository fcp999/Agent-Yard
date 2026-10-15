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

## First cut

Write a mission brief, choose a default model, then assign a different model to any role. Agent Yard sends the brief to three independent role prompts in parallel:

1. Architect: goal, constraints, and plan.
2. Builder: concrete solution outline.
3. Reviewer: ambiguities, failure modes, and verification.

Recent missions, connection settings, and per-role model choices are saved in `data/` beside the app. Clear history from the UI at any time. No prompt is sent anywhere except the Ollama endpoint you configured.

This version is a planning and review workbench. Agents do not yet edit files, run shell commands, or stay running as background workers. Those should be opt-in capabilities with per-workspace boundaries and visible approval controls in the next step.

## Test

```sh
npm test
```

## Configuration

The endpoint can be an Ollama server. Models are discovered from `/api/tags`; chat uses `/api/chat`. The settings API also accepts a model timeout from 20 to 600 seconds.
