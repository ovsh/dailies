from __future__ import annotations

import argparse
import importlib
import json
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TOOL_NAME = "dailies-avb-spike"
TOOL_VERSION = "1.0.0"
NORMALIZATION_RULE = "trim + lowercase"
FIXTURE_PATH = Path(__file__).parent / "fixtures" / "synthetic-records.json"


class HarnessError(Exception):
    pass


def normalize_clip_key(value: str) -> str:
    return value.strip().lower()


def verdict_for_rate(match_rate: float | None) -> dict[str, str]:
    if match_rate is None:
        return {
            "code": "no-data",
            "label": "NO DATA",
            "detail": "No readable records entered the denominator.",
        }
    if match_rate > 95:
        return {
            "code": "build",
            "label": "BUILD",
            "detail": "The join rate supports a future AVB membership provider.",
        }
    if match_rate >= 70:
        return {
            "code": "investigate",
            "label": "INVESTIGATE",
            "detail": "Classify the unmatched and ambiguous records before building.",
        }
    return {
        "code": "stop",
        "label": "STOP",
        "detail": "The join key does not support an AVB membership provider.",
    }


def normalized_identifier(raw: str | None) -> dict[str, str] | None:
    if raw is None:
        return None
    return {"raw": raw, "normalized": normalize_clip_key(raw)}


def load_database_clip_keys(database_path: Path) -> list[dict[str, Any]]:
    uri = f"{database_path.resolve().as_uri()}?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as exc:
        raise HarnessError(f"Cannot open the Dailies database read-only: {exc}") from exc

    try:
        rows = connection.execute(
            """
            SELECT id, path, clip_key
            FROM files
            WHERE clip_key IS NOT NULL
              AND trim(clip_key) <> ''
            ORDER BY id
            """
        ).fetchall()
    except sqlite3.Error as exc:
        raise HarnessError(
            f"Cannot read files.clip_key from the Dailies database: {exc}"
        ) from exc
    finally:
        connection.close()

    clip_keys: list[dict[str, Any]] = []
    for file_id, path, raw_clip_key in rows:
        if not isinstance(raw_clip_key, str):
            raise HarnessError(
                f"files.clip_key for file id {file_id} is not text."
            )
        clip_keys.append(
            {
                "fileId": file_id,
                "path": path,
                "clipKey": {
                    "raw": raw_clip_key,
                    "normalized": normalize_clip_key(raw_clip_key),
                },
            }
        )
    return clip_keys


def index_database_clip_keys(
    database_clip_keys: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    index: dict[str, list[dict[str, Any]]] = {}
    for row in database_clip_keys:
        normalized = row["clipKey"]["normalized"]
        index.setdefault(normalized, []).append(row)
    return index


def candidate_identifiers(record: dict[str, Any]) -> list[dict[str, str]]:
    candidates: list[dict[str, str]] = []
    for kind, field in (
        ("mobId", "mobId"),
        ("materialPackageUmid", "materialPackageUmid"),
    ):
        identifier = normalized_identifier(record.get(field))
        if identifier is None or not identifier["normalized"]:
            continue
        candidates.append({"kind": kind, **identifier})
    return candidates


def build_record_report(
    record: dict[str, Any],
    clip_key_index: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    candidates = candidate_identifiers(record)
    base = {
        "recordIndex": record.get("recordIndex"),
        "binName": record.get("binName"),
        "clipName": record.get("clipName"),
        "mobType": record.get("mobType"),
        "mobId": normalized_identifier(record.get("mobId")),
        "materialPackageUmid": normalized_identifier(
            record.get("materialPackageUmid")
        ),
        "sourceFile": record.get("sourceFile"),
        "candidateIdentifiers": candidates,
    }

    if record.get("error"):
        return {
            **base,
            "status": "error",
            "databaseMatches": [],
            "error": str(record["error"]),
        }

    matches_by_file_id: dict[Any, dict[str, Any]] = {}
    for candidate in candidates:
        for match in clip_key_index.get(candidate["normalized"], []):
            matches_by_file_id[match["fileId"]] = match

    matches = sorted(matches_by_file_id.values(), key=lambda row: row["fileId"])
    if len(matches) == 1:
        status = "matched"
    elif len(matches) > 1:
        status = "ambiguous"
    else:
        status = "unmatched"

    return {
        **base,
        "status": status,
        "databaseMatches": matches,
        "error": None,
    }


def unique_identifiers(
    records: list[dict[str, Any]], field: str
) -> list[dict[str, str]]:
    identifiers: dict[tuple[str, str], dict[str, str]] = {}
    for record in records:
        identifier = record.get(field)
        if identifier is None:
            continue
        key = (identifier["normalized"], identifier["raw"])
        identifiers[key] = identifier
    return [
        identifiers[key]
        for key in sorted(identifiers, key=lambda item: (item[0], item[1]))
    ]


def unique_candidates(
    records: list[dict[str, Any]], status: str
) -> list[dict[str, str]]:
    identifiers: dict[tuple[str, str, str], dict[str, str]] = {}
    for record in records:
        if record["status"] != status:
            continue
        for candidate in record["candidateIdentifiers"]:
            key = (
                candidate["kind"],
                candidate["normalized"],
                candidate["raw"],
            )
            identifiers[key] = candidate
    return [
        identifiers[key]
        for key in sorted(
            identifiers, key=lambda item: (item[1], item[0], item[2])
        )
    ]


def matched_clip_keys(records: list[dict[str, Any]]) -> list[dict[str, str]]:
    identifiers: dict[tuple[str, str], dict[str, str]] = {}
    for record in records:
        if record["status"] != "matched":
            continue
        for match in record["databaseMatches"]:
            identifier = match["clipKey"]
            key = (identifier["normalized"], identifier["raw"])
            identifiers[key] = identifier
    return [
        identifiers[key]
        for key in sorted(identifiers, key=lambda item: (item[0], item[1]))
    ]


def rate_from_counts(matched: int, eligible: int) -> float | None:
    if eligible == 0:
        return None
    return round(matched / eligible * 100, 2)


def verdict_from_counts(matched: int, eligible: int) -> dict[str, str]:
    if eligible == 0:
        return verdict_for_rate(None)
    if matched * 100 > eligible * 95:
        return verdict_for_rate(100)
    if matched * 100 >= eligible * 70:
        return verdict_for_rate(70)
    return verdict_for_rate(0)


def build_bin_report(
    extracted_bin: dict[str, Any],
    clip_key_index: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    records = [
        build_record_report(record, clip_key_index)
        for record in extracted_bin["records"]
    ]
    exact_matches = sum(record["status"] == "matched" for record in records)
    no_matches = sum(record["status"] == "unmatched" for record in records)
    ambiguous_matches = sum(
        record["status"] == "ambiguous" for record in records
    )
    error_records = sum(record["status"] == "error" for record in records)
    eligible_records = exact_matches + no_matches + ambiguous_matches
    match_rate = rate_from_counts(exact_matches, eligible_records)

    return {
        "binPath": extracted_bin["binPath"],
        "binName": extracted_bin["binName"],
        "records": records,
        "uniqueMobIds": unique_identifiers(records, "mobId"),
        "uniqueUmids": unique_identifiers(records, "materialPackageUmid"),
        "matchedClipKeys": matched_clip_keys(records),
        "unmatchedIds": unique_candidates(records, "unmatched"),
        "ambiguousIds": unique_candidates(records, "ambiguous"),
        "counts": {
            "records": len(records),
            "eligibleRecords": eligible_records,
            "exactMatches": exact_matches,
            "noMatches": no_matches,
            "ambiguousMatches": ambiguous_matches,
            "errorRecords": error_records,
        },
        "matchRate": match_rate,
        "verdict": verdict_from_counts(exact_matches, eligible_records),
        "error": extracted_bin.get("error"),
    }


def build_report(
    extracted_bins: list[dict[str, Any]],
    database_clip_keys: list[dict[str, Any]],
    avb_directory: str,
    database_path: str,
    generated_at: str | None = None,
) -> dict[str, Any]:
    clip_key_index = index_database_clip_keys(database_clip_keys)
    bins = [
        build_bin_report(extracted_bin, clip_key_index)
        for extracted_bin in extracted_bins
    ]
    count_names = (
        "records",
        "eligibleRecords",
        "exactMatches",
        "noMatches",
        "ambiguousMatches",
        "errorRecords",
    )
    totals = {
        name: sum(bin_report["counts"][name] for bin_report in bins)
        for name in count_names
    }
    match_rate = rate_from_counts(
        totals["exactMatches"], totals["eligibleRecords"]
    )
    ambiguous_database_keys = sum(
        len(rows) > 1 for rows in clip_key_index.values()
    )

    return {
        "tool": {"name": TOOL_NAME, "version": TOOL_VERSION},
        "generatedAt": generated_at
        or datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "inputs": {
            "avbDirectory": avb_directory,
            "databasePath": database_path,
        },
        "normalization": {
            "clipKey": NORMALIZATION_RULE,
            "semantics": "value.strip().lower()",
            "source": "src/shared/types.ts normalizeClipKey",
        },
        "database": {
            "clipKeyRows": len(database_clip_keys),
            "normalizedClipKeys": len(clip_key_index),
            "ambiguousNormalizedClipKeys": ambiguous_database_keys,
        },
        "bins": bins,
        "total": {
            "bins": len(bins),
            "parsedBins": sum(bin_report["error"] is None for bin_report in bins),
            "failedBins": sum(bin_report["error"] is not None for bin_report in bins),
            **totals,
            "matchRate": match_rate,
            "verdict": verdict_from_counts(
                totals["exactMatches"], totals["eligibleRecords"]
            ),
        },
    }


def mob_id_text(value: Any) -> str | None:
    if value is None:
        return None
    urn = getattr(value, "urn", None)
    return str(urn if urn is not None else value)


def extract_avb_file(path: Path, avb_module: Any) -> dict[str, Any]:
    source_file = str(path.resolve())
    bin_name = path.stem
    records: list[dict[str, Any]] = []
    try:
        with avb_module.open(str(path)) as avb_file:
            items = avb_file.content.items
            for record_index in range(len(items)):
                try:
                    item = items[record_index]
                    mob = item.mob
                    if mob is None:
                        raise ValueError("bin item has no mob")
                    mob_type = mob.mob_type
                    mob_id = mob_id_text(getattr(mob, "mob_id", None))
                    material_package_umid = (
                        mob_id_text(getattr(mob, "mob_id", None))
                        if mob_type == "MasterMob"
                        else None
                    )
                    records.append(
                        {
                            "recordIndex": record_index,
                            "binName": bin_name,
                            "clipName": getattr(mob, "name", None),
                            "mobType": mob_type,
                            "mobId": mob_id,
                            "materialPackageUmid": material_package_umid,
                            "sourceFile": source_file,
                            "error": None,
                        }
                    )
                except Exception as exc:
                    records.append(
                        {
                            "recordIndex": record_index,
                            "binName": bin_name,
                            "clipName": None,
                            "mobType": None,
                            "mobId": None,
                            "materialPackageUmid": None,
                            "sourceFile": source_file,
                            "error": f"{type(exc).__name__}: {exc}",
                        }
                    )
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        return {
            "binPath": source_file,
            "binName": bin_name,
            "records": [
                {
                    "recordIndex": None,
                    "binName": bin_name,
                    "clipName": None,
                    "mobType": None,
                    "mobId": None,
                    "materialPackageUmid": None,
                    "sourceFile": source_file,
                    "error": error,
                }
            ],
            "error": error,
        }

    return {
        "binPath": source_file,
        "binName": bin_name,
        "records": records,
        "error": None,
    }


def extract_avb_bins(paths: list[Path], avb_module: Any) -> list[dict[str, Any]]:
    return [extract_avb_file(path, avb_module) for path in paths]


def load_pyavb() -> Any:
    try:
        return importlib.import_module("avb")
    except ImportError as exc:
        raise HarnessError(
            "pyavb is required for real AVB files. Install "
            "scripts/avb-spike/requirements.txt in a virtual environment. "
            f"Import error: {exc}"
        ) from exc


def find_avb_files(avb_directory: Path) -> list[Path]:
    return sorted(
        (
            path
            for path in avb_directory.rglob("*")
            if path.is_file() and path.suffix.lower() == ".avb"
        ),
        key=lambda path: str(path).lower(),
    )


def rate_text(match_rate: float | None) -> str:
    return "n/a" if match_rate is None else f"{match_rate:.2f}%"


def render_stdout(report: dict[str, Any]) -> str:
    headings = (
        "BIN",
        "ELIGIBLE",
        "MATCHED",
        "UNMATCHED",
        "AMBIGUOUS",
        "ERRORS",
        "RATE",
        "VERDICT",
    )
    rows: list[tuple[str, ...]] = []
    for bin_report in report["bins"]:
        counts = bin_report["counts"]
        rows.append(
            (
                Path(bin_report["binPath"]).name,
                str(counts["eligibleRecords"]),
                str(counts["exactMatches"]),
                str(counts["noMatches"]),
                str(counts["ambiguousMatches"]),
                str(counts["errorRecords"]),
                rate_text(bin_report["matchRate"]),
                bin_report["verdict"]["label"],
            )
        )
    total = report["total"]
    rows.append(
        (
            "TOTAL",
            str(total["eligibleRecords"]),
            str(total["exactMatches"]),
            str(total["noMatches"]),
            str(total["ambiguousMatches"]),
            str(total["errorRecords"]),
            rate_text(total["matchRate"]),
            total["verdict"]["label"],
        )
    )
    widths = [
        max(len(headings[index]), *(len(row[index]) for row in rows))
        for index in range(len(headings))
    ]

    def format_row(row: tuple[str, ...]) -> str:
        return "  ".join(
            value.ljust(widths[index]) for index, value in enumerate(row)
        ).rstrip()

    lines = [format_row(headings), format_row(tuple("-" * width for width in widths))]
    lines.extend(format_row(row) for row in rows)
    for bin_report in report["bins"]:
        if bin_report["error"]:
            lines.append(f"PARSE ERROR  {bin_report['binPath']}: {bin_report['error']}")
    lines.append(f"Unreadable bins: {total['failedBins']}")
    return "\n".join(lines)


def write_json_report(report: dict[str, Any], output_path: Path) -> None:
    try:
        output_path.write_text(
            json.dumps(report, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        raise HarnessError(f"Cannot write JSON report to {output_path}: {exc}") from exc


def load_synthetic_fixture() -> dict[str, Any]:
    try:
        fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HarnessError(f"Cannot load the synthetic fixture: {exc}") from exc
    if not isinstance(fixture, dict):
        raise HarnessError("The synthetic fixture root must be an object.")
    return fixture


def create_synthetic_database(
    database_path: Path, database_clip_keys: list[dict[str, Any]]
) -> None:
    connection = sqlite3.connect(database_path)
    try:
        connection.execute(
            "CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, clip_key TEXT)"
        )
        connection.executemany(
            "INSERT INTO files (id, path, clip_key) VALUES (?, ?, ?)",
            [
                (row["fileId"], row["path"], row["clipKey"])
                for row in database_clip_keys
            ],
        )
        connection.commit()
    finally:
        connection.close()


def assert_self_test(report: dict[str, Any], expected: dict[str, Any]) -> None:
    for key, value in expected["total"].items():
        actual = report["total"][key]
        if actual != value:
            raise HarnessError(
                f"Synthetic self-test expected total.{key}={value!r}, got {actual!r}."
            )
    bins_by_path = {bin_report["binPath"]: bin_report for bin_report in report["bins"]}
    for expected_bin in expected["bins"]:
        bin_report = bins_by_path.get(expected_bin["binPath"])
        if bin_report is None:
            raise HarnessError(
                f"Synthetic self-test did not report {expected_bin['binPath']}."
            )
        for key, value in expected_bin.items():
            if key == "binPath":
                continue
            actual = (
                bin_report["verdict"]["code"]
                if key == "verdict"
                else bin_report[key]
            )
            if actual != value:
                raise HarnessError(
                    f"Synthetic self-test expected {expected_bin['binPath']} "
                    f"{key}={value!r}, got {actual!r}."
                )
    json.dumps(report)


def run_self_test() -> dict[str, Any]:
    fixture = load_synthetic_fixture()
    with tempfile.TemporaryDirectory(prefix="dailies-avb-spike-") as temp_directory:
        database_path = Path(temp_directory) / "synthetic.db"
        create_synthetic_database(database_path, fixture["databaseClipKeys"])
        database_clip_keys = load_database_clip_keys(database_path)
        report = build_report(
            fixture["bins"],
            database_clip_keys,
            avb_directory="<synthetic>",
            database_path=str(database_path),
            generated_at="2000-01-01T00:00:00Z",
        )
    assert_self_test(report, fixture["expected"])
    print(render_stdout(report))
    print("SELF-TEST PASS")
    return report


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare Avid bin mob IDs and UMIDs with Dailies clip keys."
    )
    parser.add_argument("--avb-dir", type=Path)
    parser.add_argument("--db", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)

    supplied_real_args = [args.avb_dir, args.db, args.out]
    if args.self_test:
        if any(value is not None for value in supplied_real_args):
            parser.error("--self-test cannot be combined with --avb-dir, --db, or --out")
        return args
    if any(value is None for value in supplied_real_args):
        parser.error("--avb-dir, --db, and --out are required unless --self-test is used")
    return args


def validate_real_inputs(args: argparse.Namespace) -> None:
    if not args.avb_dir.is_dir():
        raise HarnessError(f"AVB directory does not exist: {args.avb_dir}")
    if not args.db.is_file():
        raise HarnessError(f"Dailies database does not exist: {args.db}")
    if args.out.exists() and args.out.is_dir():
        raise HarnessError(f"Output path is a directory: {args.out}")
    if not args.out.parent.is_dir():
        raise HarnessError(f"Output directory does not exist: {args.out.parent}")
    if args.out.resolve() == args.db.resolve():
        raise HarnessError("The output path cannot be the Dailies database path.")


def run_real(args: argparse.Namespace) -> dict[str, Any]:
    validate_real_inputs(args)
    avb_paths = find_avb_files(args.avb_dir)
    if not avb_paths:
        raise HarnessError(f"No .avb files found under {args.avb_dir}.")
    if args.out.resolve() in {path.resolve() for path in avb_paths}:
        raise HarnessError("The output path cannot overwrite an input AVB file.")
    avb_module = load_pyavb()
    database_clip_keys = load_database_clip_keys(args.db)
    extracted_bins = extract_avb_bins(avb_paths, avb_module)
    report = build_report(
        extracted_bins,
        database_clip_keys,
        avb_directory=str(args.avb_dir.resolve()),
        database_path=str(args.db.resolve()),
    )
    write_json_report(report, args.out)
    print(render_stdout(report))
    print(f"JSON report: {args.out.resolve()}")
    return report


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.self_test:
            run_self_test()
        else:
            run_real(args)
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
