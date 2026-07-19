Remote Serial 2.1.0
===================

Remote Serial is one dependency-free Python 3.6+ program with two modes:

* Interactive terminal mode is the default.
* MCP stdio server mode is selected with --mcp.

It connects to the raw TCP serial endpoint shown by Remote Debug. It does not
open /dev/tty, install packages, or require administrator access.

Interactive terminal
--------------------

Run without an address to use the default forwarded endpoint
`127.0.0.1:39001`:

  ./remote-serial

Pass an address only when Remote Debug reports that the default port was busy
and selected a fallback:

  ./remote-serial 127.0.0.1:39001

The split form is also accepted:

  ./remote-serial 127.0.0.1 39001

Press Ctrl+] to exit an interactive session. Piped input is supported:

  printf 'help\r\n' | ./remote-serial 127.0.0.1:39001

MCP server
----------

Configure the same program with --mcp. `serial_open` defaults to
`127.0.0.1:39001`, so agents should call it without asking the user for an
endpoint. Its optional endpoint argument overrides the default when Remote
Debug reports a fallback port:

  {
    "servers": {
      "remote-serial": {
        "type": "stdio",
        "command": "/absolute/path/remote-serial",
        "args": ["--mcp"]
      }
    }
  }

Set `REMOTE_SERIAL_ENDPOINT` for a persistent terminal and MCP override.

VS Code GitHub Copilot workspace MCP configuration belongs in .vscode/mcp.json.

Shared terminal and MCP access
------------------------------

Terminal and MCP instances on the same host/container automatically share one
upstream Serial TCP connection through a per-user Unix socket under /tmp. The
first instance owns the upstream connection; later instances attach to its
temporary local broker. Device RX is broadcast to every instance, while TX
from each instance is serialized to the device.

No background daemon is created. If the owner exits, attached clients are
disconnected. Reconnect the remaining terminal or call serial_open again to
create a new owner. MCP and terminal processes must share the same /tmp.

MCP command completion
----------------------

serial_command sends exactly the supplied command plus the selected line ending,
then waits for prompt_pattern. It does not append a marker, status command, or
other shell text. The default prompt pattern recognizes common $, #, and > shell
prompts; supply a more specific pattern when serial background output can contain
those characters. serial_enter_uboot retains its dedicated U-Boot/mboot prompt
handling.

Other MCP tools
---------------

serial_open, serial_close, serial_status, serial_read, serial_clear,
serial_write, serial_write_hex, serial_wait_for, serial_command, and
serial_enter_uboot are available. Receive history is limited to 4 MiB and one
tool result to the latest 64 KiB.

The physical baud rate and 8N1 settings remain controlled by the local VS Code
Forward Serial Port command. The local broker and forwarded TCP endpoint do not
add authentication and must remain on loopback interfaces.

License
-------

Copyright 2026. Released under the MIT License; see LICENSE.txt.
