"""Shared CLI/MCP uploader boundary checks; all network operations mocked."""
from io import BytesIO
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bin"))
import psap_report as uploader


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "report"
        (self.root / "site").mkdir(parents=True)
        (self.root / "site/index.html").write_text("entry")
        self.outside = self.base / "report-private"
        self.outside.mkdir()
        (self.outside / "secret.html").write_text("DO NOT PUBLISH")
        self.plan = None
        self.after_plan = lambda: None
        self.api = self.enterContext(patch.object(uploader, "request", side_effect=self.request))
        self.put = self.enterContext(patch.object(uploader, "urlopen", side_effect=lambda *a, **k: BytesIO()))

    def request(self, url, method, data, token):
        if url.endswith("/complete"):
            return {"report": {"path": "https://reports.example/report"}}
        self.plan = data
        self.after_plan()
        return {"id": "mock", "pathMode": "preserve", "uploads": [
            {"name": f["name"], "url": "https://upload.example/" + f["name"]} for f in data["files"]]}

    def upload(self, **kwargs):
        args = dict(source=self.root, title="Report", category="ci", entry_file="site/index.html", token="mock")
        args.update(kwargs)
        return uploader.upload(**args)

    def assert_rejected(self, message, **kwargs):
        with self.assertRaisesRegex(uploader.ReportError, message) as caught:
            self.upload(**kwargs)
        self.assertNotIn("DO NOT PUBLISH", str(caught.exception))
        self.api.assert_not_called()
        self.put.assert_not_called()

    def test_outside_relative_absolute_and_chain_for_both_visibilities(self):
        link = self.root / "asset.html"
        for access in ("internal", "public"):
            for target in ("../report-private/secret.html", self.outside / "secret.html", "chain.html"):
                with self.subTest(access=access, target=target):
                    chain = self.root / "chain.html"
                    if target == "chain.html":
                        chain.symlink_to(self.outside / "secret.html")
                    link.symlink_to(target)
                    self.assert_rejected(r"(asset|chain)\.html.*outside the upload root", access=access)
                    link.unlink()
                    if chain.is_symlink():
                        chain.unlink()

    def test_in_root_file_links_and_nested_symlink_entry(self):
        (self.root / "alias.html").symlink_to("site/index.html")
        (self.root / "chain.html").symlink_to("alias.html")
        (self.root / "site/entry.html").symlink_to(self.root / "chain.html")
        self.upload(entry_file="site/entry.html")
        self.assertEqual(self.plan["entryFile"], "site/entry.html")
        self.assertEqual({f["name"] for f in self.plan["files"]}, {
            "alias.html", "chain.html", "site/index.html", "site/entry.html"})
        self.assertTrue(all(call.args[0].data == b"entry" for call in self.put.call_args_list))

    def test_dangling_and_loop_links_are_not_silently_skipped(self):
        link = self.root / "broken"
        for target in ("missing", "broken"):
            with self.subTest(target=target):
                link.symlink_to(target)
                self.assert_rejected("broken.*dangling link, symlink loop")
                link.unlink()
        link.symlink_to("second")
        (self.root / "second").symlink_to("broken")
        self.assert_rejected("(broken|second).*symlink loop")

    def test_directory_links_inside_and_outside_are_rejected(self):
        link = self.root / "assets"
        for target, message in ((self.root / "site", "Directory symlink 'assets'"),
                                (self.outside, "assets.*outside the upload root")):
            with self.subTest(target=target):
                link.symlink_to(target, target_is_directory=True)
                self.assert_rejected(message)
                link.unlink()

    def test_selected_root_symlink_uses_canonical_boundary(self):
        selected = self.base / "selected"
        selected.symlink_to(self.root, target_is_directory=True)
        self.upload(source=selected)
        self.assertEqual(self.put.call_args.args[0].data, b"entry")

    def test_single_file_symlink_explicitly_selects_target(self):
        selected = self.base / "selected.html"
        selected.symlink_to(self.outside / "secret.html")
        self.upload(source=selected, entry_file=None)
        self.assertEqual(self.plan["entryFile"], "secret.html")
        self.assertEqual(self.put.call_args.args[0].data, b"DO NOT PUBLISH")

    def test_single_file_dangling_and_loop_are_actionable(self):
        selected = self.base / "selected.html"
        for target in ("missing.html", "selected.html"):
            selected.symlink_to(target)
            self.assert_rejected("source.*dangling link, symlink loop", source=selected, entry_file=None)
            selected.unlink()

    def test_file_replaced_after_resolution_cannot_escape(self):
        original = uploader.snapshot_files
        def replace(root, files, directory):
            entry = root / "site/index.html"
            entry.unlink()
            entry.symlink_to(self.outside / "secret.html")
            return original(root, files, directory)
        with patch.object(uploader, "snapshot_files", side_effect=replace):
            self.assert_rejected("Cannot safely open or snapshot 'site/index.html'")

    def test_parent_replaced_after_resolution_cannot_escape(self):
        original = uploader.snapshot_files
        def replace(root, files, directory):
            (root / "site").rename(root / "old-site")
            (root / "site").symlink_to(self.outside, target_is_directory=True)
            return original(root, files, directory)
        with patch.object(uploader, "snapshot_files", side_effect=replace):
            self.assert_rejected("Cannot safely open or snapshot 'site/index.html'")

    def test_replacement_after_plan_uploads_only_snapshot(self):
        def replace():
            entry = self.root / "site/index.html"
            entry.unlink()
            entry.symlink_to(self.outside / "secret.html")
        self.after_plan = replace
        self.upload()
        self.assertEqual(self.put.call_args.args[0].data, b"entry")
        self.assertEqual(self.plan["files"][0]["size"], len(b"entry"))

    def test_large_bundle_reaches_api_size_validation_and_snapshots_are_cleaned(self):
        size = 100 * 1024 * 1024 + 1
        with (self.root / "large.bin").open("wb") as handle:
            handle.truncate(size)
        snapshots = {}
        original = uploader.snapshot_files
        def capture(root, files, directory):
            snapshots.update(original(root, files, directory))
            return snapshots
        def reject(url, method, data, token):
            self.assertGreater(sum(file["size"] for file in data["files"]), size)
            raise uploader.ReportError("API rejected bundle size")
        self.api.side_effect = reject
        with patch.object(uploader, "snapshot_files", side_effect=capture):
            with self.assertRaisesRegex(uploader.ReportError, "API rejected bundle size"):
                self.upload()
        self.api.assert_called_once()
        self.put.assert_not_called()
        self.assertTrue(snapshots)
        self.assertTrue(all(not path.exists() for path in snapshots.values()))


if __name__ == "__main__":
    unittest.main()
