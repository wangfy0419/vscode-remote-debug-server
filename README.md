# Remote Debug Server · Remote Workspace Extension

Use local Android devices for debugging when using [VS Code Remote Development](https://code.visualstudio.com/docs/remote/remote-overview).

- Extension ID: `xhosa.remote-debug-server`
- Version: `1.0.0`
- Install on: the VS Code remote host or development container
- Required local extension: `xhosa.remote-debug`

This makes use of the amazing [remote-adb](https://www.npmjs.com/package/remote-adb) npm package.

## Features
- Connect and share USB connected Android devices directly from the web interface.
- Easily start server and open the web interface to connect devices.
- Connected devices are available for debugging using any tools on the remote machine via `adb`.
- Expose USB fastboot devices connected to the local VS Code computer as AOSP-compatible TCP and UDP fastboot devices on the remote host.
- Expose manually selected local serial ports as raw TCP endpoints bound to remote loopback.
- Execute arbitrary non-interactive container shell commands for the local Container Shell WebSocket proxy.

## Usage
Once installed, simply search and execute these commands to get started.

- **Remote Debug: Open in browser to connect Android devices**
    - Start server and open the web interface.
    - Follow on-screen interface to connect a device.

- **Remote Debug: Stop server**
    - Stop the running server

## Container Shell

The local UI extension starts this service from the separate **Container Shell** Debug view. Each request starts a fresh `/bin/bash -lc` process, streams Base64 stdout/stderr messages, and reports the exit code. Concurrent request IDs are supported; timeout, cancellation, disconnect, and service stop terminate the associated process group.

`remote-debug-server.containerShellPath` defaults to `/bin/bash`. `remote-debug-server.containerShellCwd` selects an absolute working directory and defaults to the first remote workspace folder when empty. The service binds a random remote loopback port and is reached through the existing VS Code tunnel.

## Serial bridge

The local UI extension starts the Serial bridge after the user selects a local port and baud rate. The first selected port prefers the stable loopback endpoint `127.0.0.1:39001`; if that port is already occupied, it falls back to an available dynamic port. Additional physical serial devices receive separate ports.

- `127.0.0.1:PORT`

Serial data is transported as an acknowledged raw byte stream over a loopback WebSocket without separate Token validation. Each endpoint accepts one TCP client. Multiple physical serial devices use separate sessions and ports.

The bundled `tools/remote-serial/remote-serial` program provides both the default interactive terminal and `--mcp` stdio modes. Terminal mode without arguments and MCP `serial_open` without an endpoint both use `127.0.0.1:39001`; an explicit endpoint is only needed when the bridge reports a fallback port. Instances on the same host/container automatically share that one TCP client through a temporary per-user Unix socket, so a human terminal and MCP can receive the same device output without changing the bridge protocol.

When the local serial adapter disappears, the TCP socket is paused rather than closed. The local extension reopens a matching device and resumes the retained endpoint. Stop the session from the local Remote Debug view, or run **Remote Debug: Stop Serial bridge** to stop every Serial session.

The bridge does not implement RFC2217 or a remote PTY. Serial configuration, modem-control lines, and Break are not exposed to the TCP client.

## Fastboot bridge

The local UI extension starts the bridge automatically when a Fastboot device is connected. Each device receives dynamic endpoints bound only to remote loopback:

- `tcp:127.0.0.1:PORT`
- `udp:127.0.0.1:PORT`

`remote-debug-server.fastbootPath` selects the remote fastboot executable and defaults to `fastboot`. `remote-debug-server.fastbootAutoRegister` defaults to `true`; it registers only the TCP endpoint so one physical device is not listed twice. Disable it to manage `fastboot connect` and `fastboot disconnect` manually.

The bridge remains bound to remote loopback. Fastboot payloads are acknowledged end-to-end so large image transfers apply backpressure instead of being buffered without a bound.

Endpoint ports are retained by local USB serial while the server extension remains active. If a device temporarily disappears during `fastboot reboot bootloader`, its next bridge session reuses the same TCP and UDP serials. Reloading the remote VS Code window or stopping the Fastboot bridge clears these in-memory reservations.


*** The web interface is currently only supported Chromium-based browsers. See [compatibility for WebUSB API](https://developer.mozilla.org/en-US/docs/Web/API/USB).
