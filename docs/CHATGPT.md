# Connect chatgpt-mcp to ChatGPT

For one Linux computer, the recommended path is:

```text
ChatGPT Developer Mode
        |
OpenAI-hosted MCP tunnel endpoint
        |
        | outbound HTTPS
        v
tunnel-client on your computer
        |
        | stdio
        v
chatgpt-mcp
```

This guide follows the current OpenAI Secure MCP Tunnel and ChatGPT Developer Mode documentation:

- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://developers.openai.com/api/docs/guides/developer-mode
- https://github.com/openai/tunnel-client

## Fast path

If you want the broad full-computer configuration, first create the tunnel and runtime key described below, then run:

```sh
git clone https://github.com/platform-modules/chatgpt-mcp.git
cd chatgpt-mcp
./install.sh
```

The installer asks for the credentials with the API key hidden, builds/tests the server, installs `tunnel-client` if needed, initializes and validates the tunnel profile, and creates a persistent systemd user service.

Check it later with:

```sh
./scripts/tunnel-status.sh
```

## 1. Create the OpenAI tunnel

Open the exact Platform page:

https://platform.openai.com/settings/organization/tunnels

Create a tunnel or open an existing one. Copy the `tunnel_id`, which looks like:

```text
tunnel_0123456789abcdef0123456789abcdef
```

For ChatGPT use, make sure the tunnel is associated with the ChatGPT workspace/account that should list it.

Current OpenAI permission split:

- create/edit/delete tunnel: **Tunnels Read + Manage**
- run `tunnel-client` or select the tunnel in ChatGPT: **Tunnels Read + Use**

Tunnel permissions are organization-level. If you cannot create or use a tunnel, the relevant Platform organization owner/RBAC administrator must grant the permissions.

## 2. Create the runtime API key

Open:

https://platform.openai.com/settings/organization/api-keys

Create a normal runtime API key. Do **not** use an Admin API key for the long-lived tunnel daemon.

For least privilege, use a restricted runtime key with **Tunnels Read + Use**. The user/service-account principal that owns the key must also have those tunnel permissions.

The current tunnel-client environment variable is:

```sh
export CONTROL_PLANE_API_KEY="sk-..."
```

The installer stores the value in `.secrets/runtime-api-key` with local-only permissions instead of requiring it in your shell profile.

### Why is an API key required?

The key authenticates `tunnel-client` to the OpenAI **tunnel control plane**. It tells OpenAI that this local daemon may poll and return MCP work for the selected `tunnel_id`.

It is not used by `chatgpt-mcp` to call an OpenAI model. In the ChatGPT Developer Mode setup, ChatGPT is already the model/client; Secure MCP Tunnel is only the private transport that lets ChatGPT reach your local MCP server without opening an inbound port.

OpenAI API model billing is separate from ChatGPT billing. This project does not make a model API inference with the tunnel runtime key. The current Secure MCP Tunnel documentation does not publish a separate tunnel-pricing schedule; if OpenAI changes tunnel-service pricing later, follow the current Platform documentation.

## 3. Automated installation

From the repository root:

```sh
./install.sh
```

The installer accepts credentials from the environment too:

```sh
export CONTROL_PLANE_TUNNEL_ID='tunnel_0123456789abcdef0123456789abcdef'
export CONTROL_PLANE_API_KEY='sk-...'
./install.sh --yes
```

Do not put the key directly on the `./install.sh ...` command line or commit it to Git.

The quick installer uses [`config.full.example.json`](../config.full.example.json), which grants broad owner-controlled access. For narrower capabilities, configure `config.local.json` manually instead.

## 4. Manual stdio setup

If you do not want the installer, build manually:

```sh
corepack pnpm install
corepack pnpm gate
cp config.example.json config.local.json
corepack pnpm build
```

Set the configuration path:

```sh
export CHATGPT_MCP_CONFIG="$PWD/config.local.json"
```

The stdio command is:

```sh
node "$PWD/dist/src/stdio.js"
```

Download the current `tunnel-client` from Platform tunnel settings or the latest public OpenAI release. OpenAI recommends using the current release rather than pinning an old binary URL:

https://github.com/openai/tunnel-client/releases/latest

Initialize the profile:

```sh
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile chatgpt-computer \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --mcp-command "node /ABSOLUTE/PATH/chatgpt-mcp/dist/src/stdio.js"
```

Validate it:

```sh
tunnel-client doctor --profile chatgpt-computer --explain
```

Run it:

```sh
tunnel-client run --profile chatgpt-computer
```

Keep the client healthy while creating/testing the ChatGPT app. It only needs outbound HTTPS to OpenAI plus local access to the MCP process; no public inbound listener is required.

## 5. Optional loopback HTTP path

For a persistent local MCP HTTP endpoint instead of stdio:

```sh
export CHATGPT_MCP_CONFIG="$PWD/config.local.json"
corepack pnpm start:http
```

Default MCP URL:

```text
http://127.0.0.1:3210/mcp
```

Check it:

```sh
curl http://127.0.0.1:3210/healthz
```

Initialize the tunnel profile with `--mcp-server-url http://127.0.0.1:3210/mcp` instead of `--mcp-command`.

For one local computer, stdio is simpler because there is no second local HTTP boundary.

## 6. Enable ChatGPT Developer Mode

On ChatGPT web:

```text
Settings
  -> Security and login
  -> Developer mode
```

Then open:

https://chatgpt.com/plugins

Select the plus button, create a developer-mode app, and choose:

```text
Connection: Tunnel
```

Select the tunnel or paste its `tunnel_id` if prompted.

## 7. First calls

Enable the app for the conversation and test:

```text
Use my computer MCP's system.info tool and report the hostname and enabled capabilities.
```

Then, if filesystem read is enabled:

```text
Use fs.list on my home directory.
```

Then test shell execution if granted:

```text
Use shell.exec with command "git" and args ["--version"].
```

Tools disabled by `config.local.json` are omitted from discovery where practical.

## 8. Refresh after changing capabilities/tools

When the MCP tool surface changes, refresh the developer-mode app in ChatGPT's app settings so ChatGPT pulls the current tool list and descriptions.

## Troubleshooting

### Tunnel is not visible in ChatGPT

Verify that the tunnel is associated with the target ChatGPT workspace/account, not only the Platform organization, and that the app creator has **Tunnels Read + Use**.

### Tool calls fail although the app exists

Check the installed service:

```sh
./scripts/tunnel-status.sh
```

Or, for a manual foreground setup:

```sh
tunnel-client doctor --profile chatgpt-computer --explain
```

### stdio fails immediately

Run the command outside the tunnel first:

```sh
CHATGPT_MCP_CONFIG=/ABSOLUTE/PATH/config.local.json \
  node /ABSOLUTE/PATH/chatgpt-mcp/dist/src/stdio.js
```

It should wait for MCP input. Status/debug output belongs on stderr; stdout is protocol-only.

For interactive inspection:

```sh
npx @modelcontextprotocol/inspector \
  node /ABSOLUTE/PATH/chatgpt-mcp/dist/src/stdio.js
```

### HTTP returns 403

The server validates `Host` and `Origin`. With a same-machine tunnel, use `127.0.0.1`. For intentional non-loopback serving, configure `http.allowedHosts` and, when browser Origins are expected, `http.allowedOrigins`.
