import base64
import hashlib
import importlib.machinery
import json
import os
import socket
import threading
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "remote-container-shell-mcp", "remote-container-shell-mcp")
MODULE = importlib.machinery.SourceFileLoader("remote_container_shell_mcp", SCRIPT).load_module()


class FakeContainerShellServer(object):
    def __init__(self):
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(1)
        self.port = self.server.getsockname()[1]
        self.thread = threading.Thread(target=self._serve)
        self.thread.daemon = True
        self.thread.start()

    def _serve(self):
        connection, _address = self.server.accept()
        try:
            headers, _remainder = MODULE.read_http_headers(connection)
            values = {}
            for line in headers.split("\r\n")[1:]:
                if ":" in line:
                    name, value = line.split(":", 1)
                    values[name.lower()] = value.strip()
            accept = base64.b64encode(hashlib.sha1((values["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()).decode("ascii")
            connection.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {0}\r\n\r\n".format(accept)).encode("ascii"))
            connection.sendall(MODULE.encode_websocket_frame(json.dumps({"type": "ready", "version": 1, "shellPath": "/bin/bash", "cwd": "/workspace"}), masked=False))
            opcode, payload, _rest = MODULE.read_websocket_frame(connection)
            self.request = json.loads(payload.decode("utf-8"))
            request_id = self.request["id"]
            for message in (
                {"type": "started", "id": request_id, "pid": 123},
                {"type": "stdout", "id": request_id, "data": base64.b64encode(b"hello\n").decode("ascii")},
                {"type": "stderr", "id": request_id, "data": base64.b64encode(b"warning\n").decode("ascii")},
                {"type": "exit", "id": request_id, "exitCode": 3, "signal": None, "durationMs": 9},
            ):
                connection.sendall(MODULE.encode_websocket_frame(json.dumps(message), masked=False))
        finally:
            connection.close()
            self.server.close()

    def close(self):
        self.thread.join(5)


class RemoteContainerShellMcpTests(unittest.TestCase):
    def test_endpoint_validation_and_output_limit(self):
        self.assertEqual(MODULE.parse_endpoint("ws://127.0.0.1:44635/container-shell"), ("ws", "127.0.0.1", 44635, "/container-shell"))
        with self.assertRaises(ValueError):
            MODULE.parse_endpoint(None)
        data = bytearray()
        self.assertTrue(MODULE.append_limited(data, b"x" * (MODULE.OUTPUT_LIMIT + 1)))
        self.assertEqual(len(data), MODULE.OUTPUT_LIMIT)

    def test_container_shell_round_trip(self):
        fake = FakeContainerShellServer()
        try:
            result = MODULE.execute_container_shell("ws://127.0.0.1:{0}/container-shell".format(fake.port), "do something")
            self.assertEqual(result["stdout"], "hello\n")
            self.assertEqual(result["stderr"], "warning\n")
            self.assertEqual(result["exit_code"], 3)
            self.assertFalse(result["timed_out"])
            self.assertEqual(fake.request["command"], "do something")
            self.assertEqual(fake.request["timeoutMs"], 0)
        finally:
            fake.close()

    def test_mcp_uses_configurable_default_endpoint(self):
        server = MODULE.ContainerShellMcpServer()
        tools = server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]
        self.assertEqual(tools[0]["inputSchema"]["required"], ["command"])
        self.assertEqual(server.default_endpoint, MODULE.DEFAULT_ENDPOINT)

        original = MODULE.execute_container_shell
        calls = []
        MODULE.execute_container_shell = lambda endpoint, command: calls.append((endpoint, command)) or {"ok": True}
        try:
            self.assertTrue(server.call_tool("container_shell", {"command": "pwd"})["ok"])
            custom = MODULE.ContainerShellMcpServer("ws://127.0.0.1:45678/container-shell")
            self.assertTrue(custom.call_tool("container_shell", {"command": "uname", "endpoint": "ws://127.0.0.1:45679/container-shell"})["ok"])
        finally:
            MODULE.execute_container_shell = original
        self.assertEqual(calls[0][0], MODULE.DEFAULT_ENDPOINT)
        self.assertEqual(calls[1][0], "ws://127.0.0.1:45679/container-shell")


if __name__ == "__main__":
    unittest.main()
