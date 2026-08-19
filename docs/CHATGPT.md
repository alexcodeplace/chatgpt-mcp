# Connect chatgpt-mcp to ChatGPT

This is the shortest private-computer path:

```text
ChatGPT Developer Mode
        |
OpenAI-hosted MCP tunnel endpoint
        |
        | outbound HTTPS
        v
tunnel-client on your computer
        |
        v
chatgpt-mcp (stdio or loopback HTTP)
```

This guide follows the current OpenAI Secure MCP Tunnel and ChatGPT Developer Mode documentation:

- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://developers.openai.com/api/docs/guides/developer-mode

## 1. Build and configure this server

```sh
git clone https://github.com/platform-modules/chatgpt-mcp.git
cd chatgpt-mcp
corepack enable
corepack prepare pnpm@9.7.0 --activate
pnpm install
pnpm gate
cp config.example.json config.local.json
```

Edit `config.local.json` so it grants exactly the local capabilities you want ChatGPT to see.

## 2. Choose stdio or HTTP

### Recommended for one local machine: stdio

Build once:

```sh
pnpm build
```

The command that the tunnel will spawn is:

```sh
node /ABSOLUTE/PATH/chatgpt-mcp/dist/src/stdio.js
```

Set the configuration path in the environment in which `tunnel-client` runs:

```sh
export CHATGPT_MCP_CONFIG=/ABSOLUTE/PATH/chatgpt-mcp/config.local.json
```

### Alternative: loopback HTTP

Start the server:

```sh
export CHATGPT_MCP_CONFIG=/ABSOLUTE/PATH/chatgpt-mcp/config.local.json
pnpm start:http
```

Default MCP URL:

```text
http://127.0.0.1:3210/mcp
```

Check the local listener:

```sh
curl http://127.0.0.1:3210/healthz
```

Keep the server bound to loopback when `tunnel-client` is on the same machine.

## 3. Create an OpenAI MCP tunnel

In OpenAI Platform tunnel settings, create/manage a tunnel and obtain its `tunnel_id` plus a runtime API key usable by `tunnel-client`.

Current OpenAI docs call the runtime-key environment variable:

```sh
export CONTROL_PLANE_API_KEY="sk-..."
```

Download the current `tunnel-client` from Platform tunnel settings or the latest public `openai/tunnel-client` release. Do not pin this repository's docs to one binary release URL.

## 4. Configure tunnel-client

### stdio profile

Replace the sample tunnel ID and absolute server path:

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

### HTTP profile

Use the same `init` flow, replacing `--mcp-command` with:

```sh
--mcp-server-url http://127.0.0.1:3210/mcp
```

Then run the same `doctor` and `run` commands.

If your local HTTP MCP endpoint has `http.token` / `CHATGPT_MCP_TOKEN` enabled, configure the tunnel/client-side MCP authentication accordingly. For the same-host Secure MCP Tunnel path, stdio is simpler because there is no second local HTTP authentication hop.

## 5. Enable ChatGPT Developer Mode

On ChatGPT web:

```text
Settings
  -> Security and login
  -> Developer mode
```

OpenAI currently documents Developer Mode as available to Pro, Plus, Business, Enterprise, and Education accounts on the web.

## 6. Add the tunnel-backed app

Go to ChatGPT Plugins, select the plus button, and create a developer-mode app.

Choose:

```text
Connection: Tunnel
```

Then select the tunnel or provide its `tunnel_id` if prompted.

The tunnel must be associated with the ChatGPT workspace/account context that will use it. OpenAI Platform tunnel permissions and ChatGPT Developer Mode permission are separate controls.

## 7. Use it in a conversation

Select **Developer mode** from ChatGPT's Plus menu and enable the app for the conversation.

Useful first checks:

```text
Use my computer MCP's system.info tool and report the hostname and enabled capabilities.
```

Then, if filesystem read is enabled:

```text
Use fs.list on /home/YOU/projects.
```

Then test a configured action, for example:

```text
Use shell.exec with command "git" and args ["--version"].
```

Tools disabled by `config.local.json` are not supposed to be available for use.

## 8. Refresh after changing tools

When this repository adds/removes MCP tools, refresh the developer-mode app in ChatGPT's app settings so ChatGPT pulls the current tool list and descriptions.

## 9. Troubleshooting

### Tunnel is not visible in ChatGPT

Verify the tunnel is associated with the target ChatGPT workspace/account context and that your OpenAI Platform role has the required tunnel Read + Use permissions.

### Tool calls fail although the app exists

Confirm `tunnel-client run --profile chatgpt-computer` is still running, then:

```sh
tunnel-client doctor --profile chatgpt-computer --explain
```

For HTTP mode also check:

```sh
curl http://127.0.0.1:3210/healthz
```

### stdio fails immediately

Run the command outside the tunnel first:

```sh
CHATGPT_MCP_CONFIG=/ABSOLUTE/PATH/config.local.json \
  node /ABSOLUTE/PATH/chatgpt-mcp/dist/src/stdio.js
```

It should wait for MCP input. Any status/debug output belongs on stderr; stdout is protocol-only.

For interactive protocol inspection:

```sh
npx @modelcontextprotocol/inspector \
  node /ABSOLUTE/PATH/chatgpt-mcp/dist/src/stdio.js
```

### HTTP returns 403

The server validates `Host` and `Origin`. With a normal same-machine tunnel, use `127.0.0.1`. For intentional non-loopback serving, configure `http.allowedHosts` and, when browser Origins are expected, `http.allowedOrigins`.

## Why stdio is the default recommendation here

For one computer, stdio removes one local network boundary entirely:

```text
ChatGPT -> Secure MCP Tunnel -> tunnel-client -> spawned chatgpt-mcp process
```

HTTP remains useful when multiple local processes need to reach one persistent MCP endpoint or when `tunnel-client` runs on another machine in the same private network.
