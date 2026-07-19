import importlib.machinery
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "remote-serial", "remote-serial")
MODULE = importlib.machinery.SourceFileLoader("remote_serial", SCRIPT).load_module()


class FakeSerialServer(object):
    def __init__(self):
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(8)
        self.server.settimeout(0.1)
        self.port = self.server.getsockname()[1]
        self.accepted = 0
        self.received = bytearray()
        self.received_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.connections = []
        self.connection_threads = []
        self.thread = threading.Thread(target=self._accept_loop)
        self.thread.daemon = True
        self.thread.start()

    @property
    def endpoint(self):
        return "127.0.0.1:{0}".format(self.port)

    def _accept_loop(self):
        while not self.stop_event.is_set():
            try:
                connection, _address = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            self.accepted += 1
            self.connections.append(connection)
            thread = threading.Thread(target=self._serve, args=(connection,))
            thread.daemon = True
            self.connection_threads.append(thread)
            thread.start()

    def _serve(self, connection):
        try:
            while not self.stop_event.is_set():
                data = connection.recv(65536)
                if not data:
                    break
                with self.received_lock:
                    self.received.extend(data)
                connection.sendall(data)
                if b"prompt-command\r" in data:
                    connection.sendall(b"PROMPT-OK\r\n=> ")
                if b"reboot\r" in data:
                    connection.sendall(b"booting\r\n=> ")
        except OSError:
            pass
        finally:
            try:
                connection.close()
            except OSError:
                pass

    def wait_received(self, expected, timeout=2):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.received_lock:
                if expected in bytes(self.received):
                    return True
            time.sleep(0.01)
        return False

    def close(self):
        self.stop_event.set()
        try:
            self.server.close()
        except OSError:
            pass
        for connection in list(self.connections):
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                connection.close()
            except OSError:
                pass
        self.thread.join(2)
        for thread in self.connection_threads:
            thread.join(2)


class McpClient(object):
    def __init__(self, default_endpoint=None):
        environment = os.environ.copy()
        if default_endpoint is not None:
            environment["REMOTE_SERIAL_ENDPOINT"] = default_endpoint
        self.process = subprocess.Popen(
            [sys.executable, SCRIPT, "--mcp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            env=environment,
        )
        self.next_id = 1

    def request(self, method, params=None):
        request_id = self.next_id
        self.next_id += 1
        message = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()
        response = json.loads(self.process.stdout.readline())
        self.assert_response_id(response, request_id)
        return response

    @staticmethod
    def assert_response_id(response, request_id):
        if response.get("id") != request_id:
            raise AssertionError("unexpected response id: {0}".format(response))

    def tool(self, name, arguments=None, allow_error=False):
        response = self.request("tools/call", {"name": name, "arguments": arguments or {}})
        result = response["result"]
        if result.get("isError") and not allow_error:
            raise AssertionError(result["content"][0]["text"])
        if result.get("isError"):
            return result
        return json.loads(result["content"][0]["text"])

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            self.process.wait(5)
        stderr = self.process.stderr.read()
        self.process.stdout.close()
        self.process.stderr.close()
        if self.process.returncode != 0:
            raise AssertionError(stderr)


class RemoteSerialTests(unittest.TestCase):
    def test_helpers_and_cli_mode_validation(self):
        self.assertEqual(MODULE.DEFAULT_ENDPOINT, "127.0.0.1:39001")
        self.assertEqual(MODULE.parse_target("127.0.0.1:39001"), ("127.0.0.1", 39001))
        self.assertEqual(MODULE.parse_target("localhost", "39002"), ("localhost", 39002))
        self.assertEqual(MODULE.line_ending_bytes("crlf"), b"\r\n")
        with self.assertRaises(ValueError):
            MODULE.parse_target("missing-port")
        process = subprocess.Popen(
            [sys.executable, SCRIPT, "--mcp", "127.0.0.1:39001"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        _stdout, stderr = process.communicate(timeout=5)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn(b"does not accept an endpoint", stderr)

    def test_default_terminal_mode_round_trips_piped_input(self):
        serial = FakeSerialServer()
        try:
            process = subprocess.Popen(
                [sys.executable, SCRIPT, serial.endpoint],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            stdout, stderr = process.communicate(b"hello remote serial\n", timeout=5)
            self.assertEqual(process.returncode, 0, stderr.decode("utf-8", "replace"))
            self.assertEqual(stdout, b"hello remote serial\n")
            self.assertEqual(serial.accepted, 1)
        finally:
            serial.close()

    def test_mcp_initialization_prompt_command_and_uboot(self):
        serial = FakeSerialServer()
        client = McpClient(serial.endpoint)
        try:
            initialized = client.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})
            self.assertEqual(initialized["result"]["serverInfo"], {"name": "remote-serial", "version": "2.1.0"})
            tools = client.request("tools/list")["result"]["tools"]
            command_tool = next(tool for tool in tools if tool["name"] == "serial_command")
            self.assertNotIn("completion_mode", command_tool["inputSchema"]["properties"])
            opened = client.tool("serial_open")
            self.assertTrue(opened["connected"])
            self.assertEqual(opened["broker_role"], "owner")

            prompt = client.tool("serial_command", {"command": "prompt-command", "prompt_pattern": "(?m)=>\\s*$", "timeout": 2})
            self.assertTrue(prompt["text"].endswith("=> "))
            self.assertNotIn("completion_mode", prompt)
            self.assertNotIn("exit_code", prompt)
            sent = bytes(serial.received).decode("utf-8", "replace")
            self.assertIn("prompt-command\r", sent)
            self.assertNotIn("DONE", sent)

            bootloader = client.tool("serial_enter_uboot", {"reboot_command": "reboot", "enter_window": 0.2, "enter_interval": 0.05, "prompt_timeout": 0.2})
            self.assertGreaterEqual(bootloader["enters_sent"], 1)
            self.assertIn("=> ", bootloader["text"])
            self.assertFalse(client.tool("serial_close")["connected"])
        finally:
            client.close()
            serial.close()

    def test_mcp_owner_and_terminal_client_share_one_upstream(self):
        serial = FakeSerialServer()
        client = McpClient()
        terminal = None
        try:
            self.assertEqual(client.tool("serial_open", {"endpoint": serial.endpoint})["broker_role"], "owner")
            terminal, broker, role = MODULE.open_shared_connection(serial.endpoint, 2)
            self.assertIsNone(broker)
            self.assertEqual(role, "client")
            terminal.sendall(b"from-human")
            self.assertTrue(serial.wait_received(b"from-human"))
            self.assertEqual(terminal.recv(1024), b"from-human")
            mcp_read = client.tool("serial_read", {"timeout": 2})
            self.assertIn("from-human", mcp_read["text"])
            client.tool("serial_write", {"text": "from-mcp"})
            self.assertEqual(terminal.recv(1024), b"from-mcp")
            self.assertEqual(serial.accepted, 1)
        finally:
            if terminal is not None:
                terminal.close()
            client.close()
            serial.close()

    def test_terminal_owner_and_mcp_client_share_one_upstream(self):
        serial = FakeSerialServer()
        owner = None
        broker = None
        client = McpClient()
        try:
            owner, broker, role = MODULE.open_shared_connection(serial.endpoint, 2)
            self.assertEqual(role, "owner")
            self.assertEqual(client.tool("serial_open", {"endpoint": serial.endpoint})["broker_role"], "client")
            client.tool("serial_write", {"text": "mcp-second"})
            self.assertEqual(owner.recv(1024), b"mcp-second")
            owner.sendall(b"human-first")
            self.assertTrue(serial.wait_received(b"human-first"))
            self.assertIn("human-first", client.tool("serial_read", {"timeout": 2})["text"])
            self.assertEqual(serial.accepted, 1)
        finally:
            client.close()
            if owner is not None:
                owner.close()
            if broker is not None:
                broker.stop()
            serial.close()

    def test_owner_exit_disconnects_clients_and_manual_reconnect_cleans_socket(self):
        serial = FakeSerialServer()
        owner = client = replacement = None
        first_broker = replacement_broker = None
        try:
            owner, first_broker, _role = MODULE.open_shared_connection(serial.endpoint, 2)
            client, _broker, role = MODULE.open_shared_connection(serial.endpoint, 2)
            self.assertEqual(role, "client")
            _directory, _socket_path, lock_path = MODULE.broker_paths(serial.endpoint)
            competing_lock = open(lock_path, "a+")
            try:
                with self.assertRaises(OSError):
                    MODULE.fcntl.flock(competing_lock.fileno(), MODULE.fcntl.LOCK_EX | MODULE.fcntl.LOCK_NB)
            finally:
                competing_lock.close()
            first_broker.stop()
            client.settimeout(2)
            self.assertEqual(client.recv(1), b"")
            replacement, replacement_broker, role = MODULE.open_shared_connection(serial.endpoint, 2)
            self.assertEqual(role, "owner")
            deadline = time.monotonic() + 2
            while serial.accepted < 2 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(serial.accepted, 2)
        finally:
            for connection in (owner, client, replacement):
                if connection is not None:
                    connection.close()
            if first_broker is not None:
                first_broker.stop()
            if replacement_broker is not None:
                replacement_broker.stop()
            serial.close()

    def test_slow_client_queue_is_bounded(self):
        class DummyBroker(object):
            def remove_peer(self, _peer):
                pass

            def send_upstream(self, _data):
                pass

        first, second = socket.socketpair()
        try:
            peer = MODULE.BrokerPeer(DummyBroker(), first)
            self.assertTrue(peer.enqueue(b"x" * MODULE.CLIENT_QUEUE_LIMIT))
            self.assertFalse(peer.enqueue(b"y"))
            self.assertTrue(peer.closed.is_set())
        finally:
            first.close()
            second.close()

    def test_mcp_tool_errors_are_structured(self):
        serial = FakeSerialServer()
        server = MODULE.RemoteSerialMcpServer(serial.endpoint)
        try:
            response = server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "serial_write", "arguments": {"text": "x"}}})
            self.assertTrue(response["result"]["isError"])
            self.assertIn("not connected", response["result"]["content"][0]["text"])
            opened = server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "serial_open", "arguments": {}}})
            self.assertFalse(opened["result"].get("isError", False))
            self.assertEqual(json.loads(opened["result"]["content"][0]["text"])["endpoint"], serial.endpoint)
        finally:
            server.session.close()
            serial.close()


if __name__ == "__main__":
    unittest.main()
