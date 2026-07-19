# Change Log

## 1.0.3

- Fix extension activation by bundling the JSONC parser implementation used for Copilot MCP configuration updates.

## 1.0.2

- Open the bundled `remote-serial` tool in a remote editor-area terminal.
- Register the bundled Serial MCP server with GitHub Copilot or Claude Code from the client device menu.

## 1.0.1

- Remove Fastboot bridge token validation and its diagnostic configuration setting.
- Confirm explicit Fastboot disconnect requests only after the registered TCP device has been removed, and report cleanup failures instead of silently swallowing them.
- Prefer `127.0.0.1:39001` for the first forwarded Serial endpoint and allocate a different port only when it is occupied.
- Update Remote Serial to 2.1.0 so terminal mode and MCP `serial_open` use the same default endpoint without asking the user each time.

## 1.0.0

- Rebrand the remote workspace extension as `xhosa.remote-debug-server`.
- Rename the extension-owned commands and settings from `remote-adb-server` to `remote-debug-server`.

## 0.4.10

- Add the loopback-only Container Shell WebSocket execution service with concurrent commands, streamed output, cancellation, timeout, and process cleanup.

## 0.4.9

- Add a loopback Serial WebSocket bridge without separate Token validation, with one TCP endpoint per selected local serial device.
- Preserve TCP endpoints while a serial adapter is detached, apply DATA/ACK backpressure, reject a second TCP consumer, and retain ports across transport reconnects.
- Share the bridge frame codec with Fastboot without changing the Fastboot protocol or endpoint behavior.

## 0.4.8

- Detect binary WebSocket frames from their payload type, matching the installed ws 7 callback API so TCP/UDP commands and USB responses cross the bridge.
- Add a real local fastboot CLI integration test covering TCP framing, authenticated WebSocket transport, and a mock WebUSB response.

## 0.4.7

- Add directional TCP/UDP, WebSocket bridge, and USB response diagnostics, including an explicit warning when USB data has no owning remote client.

## 0.4.6

- Retain each Fastboot device's TCP and UDP ports by local serial across USB/WebSocket reconnects, including `reboot bootloader` cycles.
- Wait for the previous transport to release its endpoints before reconnecting the same physical device.

## 0.4.5

- Add the temporary diagnostic setting `remote-adb-server.fastbootRequireToken` and log token presence on rejected WebSocket upgrades without exposing token values.

## 0.4.4

- Return the private Fastboot bridge endpoint so the UI extension can create a raw SSH/container relay without using VS Code's authenticated Web proxy.

## 0.4.3

- Allocate the Fastboot bridge on a random port to prevent collisions with VS Code's own SSH/Code Helper listeners.

## 0.4.2

- Let the local UI extension create the Fastboot port tunnel instead of returning a VS Code Server proxy URL.

## 0.4.1

- Add token-protected Fastboot WebSocket bridge sessions.
- Add loopback AOSP TCP and UDP fastboot endpoints with dynamic per-device ports.
- Add configurable automatic TCP registration using the remote fastboot executable.
- Preserve VS Code Remote tunnel authentication while passing the Fastboot token in a WebSocket header.

All notable changes to the "remote-adb-server" extension will be documented in this file.

## 0.4.0
- Bump [remote-adb](https://github.com/nisargjhaveri/remote-adb) to 3.2.0

## 0.3.0
- Change command prefixes from `remote-adb` to `remote-adb-server`.
- Bump [remote-adb](https://github.com/nisargjhaveri/remote-adb) to 3.1.0

## 0.2.1
- Start server on same or similar ports across runs, this helps remember device permissions in the browser.
- npm audit fix

## 0.2.0
- Bump [remote-adb](https://github.com/nisargjhaveri/remote-adb) to 3.0.1
- Start server on local 127.0.0.1 instead of the publicly accessible

## 0.1.0
- Initial release
- Ability to start/stop the server and open web interface using simple VS Code commands.
- Simple API for extending the functionality on the client side.
