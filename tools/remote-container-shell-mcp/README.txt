Remote Container Shell MCP 1.0.2
================================

A dependency-free Python 3 stdio MCP server that executes non-interactive shell
commands in the active VS Code remote container through the Container Shell
WebSocket endpoint.

Configure the executable as a stdio MCP server. container_shell requires only
command and defaults to ws://127.0.0.1:44635/container-shell. endpoint remains
an optional per-call override.

Example .vscode/mcp.json:

  {
    "servers": {
      "container-shell": {
        "type": "stdio",
        "command": "/absolute/path/remote-container-shell-mcp"
      }
    }
  }

Change the default endpoint with a startup argument:

  /absolute/path/remote-container-shell-mcp --endpoint ws://127.0.0.1:45678/container-shell

Or set CONTAINER_SHELL_ENDPOINT in the MCP process environment.

The service is bound to local loopback and does not add authentication. Each
tool call starts a fresh shell command in the configured container working
directory. State such as cd and exported variables is not retained between
calls. The tool does not impose a command timeout. stdout and stderr are each
limited to 8 MiB in an MCP result.

Codex has its own MCP tool timeout, independent of this server. For long-running
commands, set a sufficiently large tool_timeout_sec in the Codex MCP config.
