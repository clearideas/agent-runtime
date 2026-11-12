"""Exercise real HTTP forwarding, including visitor cookies and streaming."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest
from urllib.request import Request, urlopen

import httpx

from gateway import proxy_handler


class GatewayTests(unittest.TestCase):
    def test_cookies_do_not_cross_visitors_and_streams_arrive_before_completion(self):
        release = threading.Event()
        mutations = []

        class Application(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Set-Cookie", "visitor=assigned; Path=/; HttpOnly")
                self.end_headers()
                if self.path == "/stream":
                    self.wfile.write(b'{"status":"running"}\n')
                    self.wfile.flush()
                    release.wait(5)
                    self.wfile.write(b'{"status":"done"}\n')
                else:
                    self.wfile.write(self.headers.get("Cookie", "no-cookie").encode())

            def log_message(self, *_args):
                pass

        application = ThreadingHTTPServer(("127.0.0.1", 0), Application)
        threading.Thread(target=application.serve_forever, daemon=True).start()
        client = httpx.Client(timeout=5)
        proxy = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            proxy_handler(f"http://127.0.0.1:{application.server_port}", client, lambda: mutations.append(True)),
        )
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{proxy.server_port}"
        try:
            # A prior visitor has populated the shared client's upstream jar.
            with urlopen(base, timeout=5) as response:
                self.assertEqual(response.read(), b"no-cookie")
                self.assertIn("visitor=assigned", response.headers["Set-Cookie"])
            self.assertIn("visitor", client.cookies)
            with urlopen(base, timeout=5) as response:
                self.assertEqual(response.read(), b"no-cookie", "new visitors must not inherit the upstream jar")
            with urlopen(Request(base, headers={"Cookie": "visitor=alice"}), timeout=5) as response:
                self.assertEqual(response.read(), b"visitor=alice")
            with urlopen(base + "/stream", timeout=5) as response:
                self.assertEqual(response.readline(), b'{"status":"running"}\n')
                self.assertFalse(release.is_set(), "first event must arrive before completion")
                release.set()
                self.assertEqual(response.readline(), b'{"status":"done"}\n')
            self.assertEqual(mutations, [], "GET requests never trigger persistence writes")
        finally:
            release.set()
            proxy.shutdown()
            proxy.server_close()
            application.shutdown()
            application.server_close()
            client.close()


if __name__ == "__main__":
    unittest.main()
