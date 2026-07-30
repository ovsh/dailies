from __future__ import annotations

import io
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SPIKE_DIRECTORY = Path(__file__).parent
sys.path.insert(0, str(SPIKE_DIRECTORY))

import report


class ReportTests(unittest.TestCase):
    def test_normalize_clip_key_matches_typescript_semantics(self) -> None:
        self.assertEqual(report.normalize_clip_key("  AbC-123  "), "abc-123")
        self.assertEqual(report.normalize_clip_key("\tURN:SMPTE:UMID:X\n"), "urn:smpte:umid:x")

    def test_verdict_thresholds(self) -> None:
        self.assertEqual(report.verdict_for_rate(95.01)["code"], "build")
        self.assertEqual(report.verdict_for_rate(95.0)["code"], "investigate")
        self.assertEqual(report.verdict_for_rate(70.0)["code"], "investigate")
        self.assertEqual(report.verdict_for_rate(69.99)["code"], "stop")
        self.assertEqual(report.verdict_for_rate(None)["code"], "no-data")
        self.assertEqual(report.verdict_from_counts(19001, 20000)["code"], "build")

    def test_join_aggregation_and_denominator_rules(self) -> None:
        database_rows = [
            {
                "fileId": 1,
                "path": "/media/one.mxf",
                "clipKey": {"raw": " Key-One ", "normalized": "key-one"},
            },
            {
                "fileId": 2,
                "path": "/media/two.mxf",
                "clipKey": {"raw": "dupe", "normalized": "dupe"},
            },
            {
                "fileId": 3,
                "path": "/media/three.mxf",
                "clipKey": {"raw": " DUPE ", "normalized": "dupe"},
            },
        ]
        extracted_bins = [
            {
                "binPath": "/bins/test.avb",
                "binName": "test",
                "records": [
                    {
                        "recordIndex": 0,
                        "binName": "test",
                        "clipName": "Match",
                        "mobType": "MasterMob",
                        "mobId": "KEY-ONE",
                        "materialPackageUmid": None,
                        "sourceFile": "/bins/test.avb",
                        "error": None,
                    },
                    {
                        "recordIndex": 1,
                        "binName": "test",
                        "clipName": "Ambiguous",
                        "mobType": "MasterMob",
                        "mobId": "dupe",
                        "materialPackageUmid": None,
                        "sourceFile": "/bins/test.avb",
                        "error": None,
                    },
                    {
                        "recordIndex": 2,
                        "binName": "test",
                        "clipName": "Missing",
                        "mobType": "MasterMob",
                        "mobId": "missing",
                        "materialPackageUmid": None,
                        "sourceFile": "/bins/test.avb",
                        "error": None,
                    },
                    {
                        "recordIndex": 3,
                        "binName": "test",
                        "clipName": None,
                        "mobType": None,
                        "mobId": None,
                        "materialPackageUmid": None,
                        "sourceFile": "/bins/test.avb",
                        "error": "cannot read record",
                    },
                ],
                "error": None,
            }
        ]

        built = report.build_report(
            extracted_bins,
            database_rows,
            "/bins",
            "/db/dailies.db",
            generated_at="2000-01-01T00:00:00Z",
        )

        self.assertEqual(built["total"]["eligibleRecords"], 3)
        self.assertEqual(built["total"]["exactMatches"], 1)
        self.assertEqual(built["total"]["ambiguousMatches"], 1)
        self.assertEqual(built["total"]["noMatches"], 1)
        self.assertEqual(built["total"]["errorRecords"], 1)
        self.assertEqual(built["total"]["matchRate"], 33.33)
        self.assertEqual(built["bins"][0]["records"][3]["status"], "error")

    def test_database_is_read_without_changing_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp_directory:
            database_path = Path(temp_directory) / "dailies.db"
            connection = sqlite3.connect(database_path)
            connection.execute(
                "CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, clip_key TEXT)"
            )
            connection.execute(
                "INSERT INTO files (path, clip_key) VALUES (?, ?)",
                ("/media/a.mxf", " Key-A "),
            )
            connection.commit()
            connection.close()

            rows = report.load_database_clip_keys(database_path)

            self.assertEqual(rows[0]["clipKey"]["raw"], " Key-A ")
            self.assertEqual(rows[0]["clipKey"]["normalized"], "key-a")
            check = sqlite3.connect(database_path)
            count = check.execute("SELECT count(*) FROM files").fetchone()[0]
            check.close()
            self.assertEqual(count, 1)

    def test_pyavb_missing_error_is_clear(self) -> None:
        with patch.object(
            report.importlib,
            "import_module",
            side_effect=ModuleNotFoundError("No module named 'avb'"),
        ):
            with self.assertRaisesRegex(report.HarnessError, "pyavb is required"):
                report.load_pyavb()

    def test_parse_failure_is_a_nonfatal_bin_report(self) -> None:
        class FakeAvbFile:
            def __init__(self, items: list[object]) -> None:
                self.content = SimpleNamespace(items=items)

            def __enter__(self) -> "FakeAvbFile":
                return self

            def __exit__(self, *args: object) -> None:
                return None

        class FakeAvb:
            def open(self, path: str) -> FakeAvbFile:
                if path.endswith("bad.avb"):
                    raise ValueError("bad bin")
                mob_id = SimpleNamespace(urn=" URN:SMPTE:UMID:GOOD ")
                mob = SimpleNamespace(
                    name="Good Clip",
                    mob_type="MasterMob",
                    mob_id=mob_id,
                )
                return FakeAvbFile([SimpleNamespace(mob=mob)])

        bins = report.extract_avb_bins(
            [Path("/bins/good.avb"), Path("/bins/bad.avb")],
            FakeAvb(),
        )

        self.assertIsNone(bins[0]["error"])
        self.assertEqual(
            bins[0]["records"][0]["materialPackageUmid"],
            " URN:SMPTE:UMID:GOOD ",
        )
        self.assertIn("ValueError: bad bin", bins[1]["error"])
        self.assertEqual(bins[1]["records"][0]["error"], bins[1]["error"])

    def test_synthetic_self_test(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            built = report.run_self_test()

        self.assertIn("SELF-TEST PASS", output.getvalue())
        self.assertEqual(built["total"]["matchRate"], 60.0)


if __name__ == "__main__":
    unittest.main()
