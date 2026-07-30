# AVB spike report

This offline tool tests whether identifiers in Avid `.avb` bins match
`files.clip_key` values in a Dailies SQLite database. It does not run in the
app and it does not need network access.

Do not use the result as a real spike verdict until you have the paired Avid
project bins and Dailies database for the same media.

## Synthetic self-test

The self-test does not need pyavb or real `.avb` files. It creates a temporary
SQLite database and loads extracted identifiers from
`fixtures/synthetic-records.json`.

```sh
python3 scripts/avb-spike/report.py --self-test
python3 -m unittest scripts/avb-spike/test_report.py
python3 -m py_compile scripts/avb-spike/report.py
```

The first command must end with `SELF-TEST PASS`.

## Isolated pyavb setup

Install pyavb in a virtual environment before you move the inputs into an
offline environment. Do not add pyavb to the app package.

```sh
python3 -m venv /tmp/dailies-avb-spike-venv
/tmp/dailies-avb-spike-venv/bin/python -m pip install -r scripts/avb-spike/requirements.txt
```

## Real bins

Run this command from the repository root:

```sh
/tmp/dailies-avb-spike-venv/bin/python scripts/avb-spike/report.py \
  --avb-dir "<Ken-project-folder>" \
  --db "<matching-dailies.db>" \
  --out "<report.json>"
```

The tool walks all `.avb` files under `--avb-dir`. It opens the database in
SQLite read-only mode. A missing pyavb installation produces a setup error.
An unreadable bin produces a parse-error row, but the run continues.

Each record has the bin name, clip name, mob type, mob ID, material-package
UMID when the pyavb mob is a `MasterMob`, and source `.avb` file. The JSON
keeps each raw identifier beside its normalized value.

The join uses the same rule as `normalizeClipKey` in `src/shared/types.ts`.
Trim the value, then convert it to lowercase. A record has these states:

- `matched` means all matching identifiers resolve to one `files` row.
- `ambiguous` means the identifiers resolve to more than one `files` row.
- `unmatched` means no identifier resolves to a `files` row.
- `error` means the record could not be read. Error records do not enter the
  match-rate denominator.

The JSON report and stdout table come from the same result object. Each bin
and the total have one verdict:

- Above 95 percent is `BUILD`.
- From 70 through 95 percent is `INVESTIGATE`.
- Below 70 percent is `STOP`.
- No eligible records is `NO DATA`.

For a real verdict, inspect at least one matched record and one unmatched
record in each bin. Compare the raw AVB identifiers with `files.clip_key`.
Recompute each rate as `exactMatches / eligibleRecords * 100`.
