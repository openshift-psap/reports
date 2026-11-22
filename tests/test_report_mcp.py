"""Real stdio MCP client against a local mock API; no live credentials/uploads."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

REPO = Path(__file__).resolve().parents[1]
SECRET = "mock-credential-never-return"
SIGNED = "signed-upload-secret"


class MCPTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copytree(REPO / "bin", self.root / "bin")
        self.home = self.root / "home"
        self.cache = self.home / ".config/psap-report/github-oauth.json"
        self.cache.parent.mkdir(parents=True)
        self.cache.write_text(json.dumps({"access_token": SECRET}))
        self.source = self.root / "source"
        (self.source / "site/assets").mkdir(parents=True)
        (self.source / "site/index.html").write_text('<link href="assets/style.css">')
        (self.source / "site/assets/style.css").write_text("body { color: blue; }")
        self.plan = None
        self.uploads = {}
        self.completes = 0
        self.failure = None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                owner.assertEqual(self.headers.get("Authorization"), f"Bearer {SECRET}")
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                stage = "complete" if self.path.endswith("/complete") else "plan"
                if owner.failure == ("malformed", stage):
                    self.send_json(200, {"unexpected": SECRET + SIGNED})
                elif owner.failure == ("signed-result", stage):
                    self.send_json(201, {"report": {"path": "https://s3.example/?signature=" + SIGNED}})
                elif owner.failure and owner.failure[0] == stage:
                    self.send_json(owner.failure[1], {"error": SECRET + " https://s3.example/?signature=" + SIGNED})
                elif stage == "plan":
                    owner.plan = body
                    self.send_json(201, {"id": "mock-id", "pathMode": "preserve", "uploads": [
                        {"name": f["name"], "url": owner.url + "/" + f["name"] + "?signature=" + SIGNED}
                        for f in body["files"]]})
                else:
                    owner.completes += 1
                    self.send_json(201, {"report": {"path": "https://reports.example/private/report.html"}, "ignored": SECRET})

            def do_PUT(self):
                owner.assertIsNone(self.headers.get("Authorization"))
                body = self.rfile.read(int(self.headers["Content-Length"]))
                if owner.failure and owner.failure[0] == "upload":
                    self.send_json(403, {"error": SECRET + SIGNED})
                else:
                    owner.uploads[self.path.split("?")[0]] = body.decode()
                    self.send_json(200, {})

            def send_json(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.http.server_port}"
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        (self.root / "_generator").mkdir()
        (self.root / "_generator/s3_config.json").write_text(json.dumps({
            "cli_report_api_url": self.url, "github_client_id": "mock-client"}))

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()

    async def call(self, **overrides):
        args = dict(source="source", entry_file="site/index.html", title="Test report", category="ci")
        args.update(overrides)
        params = StdioServerParameters(command=sys.executable,
            args=[str(self.root / "bin/psap-report-mcp")], cwd=str(self.root),
            env={**os.environ, "HOME": str(self.home)})
        with (self.root / "stderr.log").open("w+") as errors:
            async with asyncio.timeout(15):
                async with stdio_client(params, errlog=errors) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        tools = await session.list_tools()
                        self.assertEqual([tool.name for tool in tools.tools], ["upload_report"])
                        result = await session.call_tool("upload_report", args)
            errors.seek(0)
            exposed = errors.read() + result.model_dump_json()
            self.assertNotIn(SECRET, exposed)
            self.assertNotIn(SIGNED, exposed)
            return result

    async def test_directory_and_metadata(self):
        result = await self.call(tags=" gpu, rhoai, ", description="Description")
        self.assertFalse(result.isError)
        self.assertEqual(result.structuredContent, {"id": "mock-id", "path": "https://reports.example/private/report.html"})
        self.assertEqual(self.plan["access"], "authenticated")
        self.assertEqual(self.plan["tags"], ["gpu", "rhoai"])
        self.assertEqual(self.plan["description"], "Description")
        self.assertEqual(self.plan["title"], "Test report")
        self.assertEqual(self.plan["category"], "ci")
        self.assertEqual(self.plan["entryFile"], "site/index.html")
        self.assertEqual(self.plan["pathMode"], "preserve")
        self.assertEqual(self.uploads, {"/site/index.html": '<link href="assets/style.css">', "/site/assets/style.css": "body { color: blue; }"})
        self.assertEqual(self.completes, 1)

    async def test_standalone_public(self):
        result = await self.call(source=str(self.source / "site/index.html"), entry_file=None, access="public")
        self.assertFalse(result.isError)
        self.assertEqual(self.plan["access"], "public")
        self.assertEqual(list(self.uploads), ["/index.html"])

    async def test_missing_and_corrupt_auth_do_not_start_login(self):
        for content in (None, "bad json", '{}'):
            if content is None:
                self.cache.unlink()
            else:
                self.cache.write_text(content)
            result = await self.call()
            self.assertTrue(result.isError)
            self.assertIn("--login", result.content[0].text)
            self.assertIsNone(self.plan)

    async def test_invalid_entry_paths(self):
        for entry in (None, "../index.html", "/site/index.html", "./site/index.html", "missing.html"):
            result = await self.call(entry_file=entry)
            self.assertTrue(result.isError)
            self.assertIn("entry", result.content[0].text.lower())
            self.assertIsNone(self.plan)

    async def test_outside_symlink_rejects_entire_bundle_before_plan(self):
        outside = self.root / "private.html"
        outside.write_text("private file contents")
        (self.source / "site/leak.html").symlink_to(outside)
        result = await self.call()
        self.assertTrue(result.isError)
        self.assertIn("site/leak.html", result.content[0].text)
        self.assertIn("outside the upload root", result.content[0].text)
        self.assertNotIn("private file contents", result.content[0].text)
        self.assertIsNone(self.plan)
        self.assertEqual(self.uploads, {})
        self.assertEqual(self.completes, 0)

    async def test_rejections_and_failure_redaction(self):
        for stage, status, message in (("plan", 401, "--login"), ("plan", 403, "membership"),
                ("plan", 400, "metadata"), ("upload", 403, "File upload failed"),
                ("complete", 500, "Completion failed"), ("complete", 401, "--login")):
            with self.subTest(stage=stage, status=status):
                self.failure = (stage, status)
                result = await self.call()
                self.assertTrue(result.isError)
                self.assertIn(message, result.content[0].text)

    async def test_malformed_responses_and_signed_results_are_not_exposed(self):
        for failure in (("malformed", "plan"), ("malformed", "complete"), ("signed-result", "complete")):
            with self.subTest(failure=failure):
                self.failure = failure
                result = await self.call()
                self.assertTrue(result.isError)


if __name__ == "__main__":
    unittest.main()
