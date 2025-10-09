#!/usr/bin/env python3
"""Parallel URL scraper that aggregates responses in a JSON file."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import sys
import time
from pathlib import Path
from typing import Iterable, List
from urllib import error as url_error
from urllib import request as url_request

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Download multiple URLs concurrently and write their bodies to a single JSON file."
        )
    )
    parser.add_argument(
        "--url",
        action="append",
        dest="urls",
        default=[],
        help="URL to scrape (can be provided multiple times)",
    )
    parser.add_argument(
        "--urls-file",
        action="append",
        dest="urls_files",
        default=[],
        help=(
            "Path to a file containing newline-separated URLs; use '-' to read from stdin"
        ),
    )
    parser.add_argument(
        "--output",
        default="scraped_content.json",
        help="Output JSON file path (default: scraped_content.json)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=15.0,
        help="Per-request timeout in seconds (default: 15)",
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        default=None,
        help="Number of concurrent workers (default: based on CPU count)",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=1_000_000,
        help=(
            "Maximum bytes to read for each response body before truncating (default: 1,000,000)"
        ),
    )
    parser.add_argument(
        "--user-agent",
        default=DEFAULT_USER_AGENT,
        help="User-Agent header to send with each request",
    )
    return parser.parse_args()


def load_urls(args: argparse.Namespace) -> List[str]:
    urls: List[str] = []

    if args.urls:
        urls.extend(args.urls)

    for file_path in args.urls_files:
        urls.extend(read_urls_file(file_path))

    # Remove duplicates while keeping order.
    seen = set()
    unique: List[str] = []
    for url in urls:
        if url and url not in seen:
            unique.append(url)
            seen.add(url)
    return unique


def read_urls_file(path: str) -> Iterable[str]:
    def _iter_lines(lines: Iterable[str]) -> Iterable[str]:
        for raw_line in lines:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            yield line

    if path == "-":
        return list(_iter_lines(sys.stdin))

    with open(path, "r", encoding="utf-8") as handle:
        return list(_iter_lines(handle))


def fetch_url(
    index: int,
    url: str,
    *,
    timeout: float,
    max_bytes: int,
    user_agent: str,
) -> dict:
    started = time.perf_counter()
    request = url_request.Request(url, headers={"User-Agent": user_agent})

    try:
        with url_request.urlopen(request, timeout=timeout) as response:
            status_code = getattr(response, "status", None)
            content_type = response.headers.get("Content-Type", "")
            raw = response.read(max_bytes + 1)
            truncated = len(raw) > max_bytes
            if truncated:
                raw = raw[:max_bytes]

            # Try decoding using declared charset; fallback to utf-8.
            charset = response.headers.get_content_charset() or "utf-8"
            try:
                body = raw.decode(charset, errors="replace")
            except LookupError:
                body = raw.decode("utf-8", errors="replace")

            elapsed = time.perf_counter() - started
            return {
                "index": index,
                "url": url,
                "status": status_code,
                "content_type": content_type,
                "elapsed_seconds": round(elapsed, 3),
                "truncated": truncated,
                "content": body,
            }

    except url_error.HTTPError as exc:
        elapsed = time.perf_counter() - started
        return {
            "index": index,
            "url": url,
            "status": exc.code,
            "content_type": exc.headers.get("Content-Type", "") if exc.headers else "",
            "elapsed_seconds": round(elapsed, 3),
            "error": f"HTTPError: {exc.code} {exc.reason}",
        }
    except url_error.URLError as exc:
        elapsed = time.perf_counter() - started
        return {
            "index": index,
            "url": url,
            "elapsed_seconds": round(elapsed, 3),
            "error": f"URLError: {exc.reason}",
        }
    except Exception as exc:  # noqa: BLE001 - want to capture unexpected issues
        elapsed = time.perf_counter() - started
        return {
            "index": index,
            "url": url,
            "elapsed_seconds": round(elapsed, 3),
            "error": f"Unexpected error: {exc}",
        }


def compute_workers(args: argparse.Namespace, total_urls: int) -> int:
    if total_urls <= 1:
        return 1

    if args.max_workers:
        return max(1, args.max_workers)

    cpu_count = os.cpu_count() or 4
    return max(1, min(total_urls, cpu_count * 5))


def write_output(path: str, results: List[dict]) -> None:
    output_path = Path(path).expanduser()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    for entry in results:
        entry.pop("index", None)

    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(results, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def main() -> None:
    args = parse_args()
    urls = load_urls(args)
    if not urls:
        print("No URLs provided. Use --url or --urls-file to supply targets.", file=sys.stderr)
        sys.exit(1)

    workers = compute_workers(args, len(urls))
    print(f"Scraping {len(urls)} URL(s) with {workers} worker(s)...")

    results: List[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        future_to_index = {
            executor.submit(
                fetch_url,
                index,
                url,
                timeout=args.timeout,
                max_bytes=args.max_bytes,
                user_agent=args.user_agent,
            ): index
            for index, url in enumerate(urls)
        }

        for future in concurrent.futures.as_completed(future_to_index):
            try:
                results.append(future.result())
            except Exception as exc:  # noqa: BLE001 - defensive catch
                index = future_to_index[future]
                results.append(
                    {
                        "index": index,
                        "url": urls[index],
                        "error": f"Worker crashed: {exc}",
                    }
                )

    # Restore original ordering.
    results.sort(key=lambda entry: entry["index"])
    write_output(args.output, results)

    ok = sum(1 for entry in results if "error" not in entry)
    print(f"Finished. {ok}/{len(results)} succeeded. Output -> {args.output}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Interrupted by user.", file=sys.stderr)
        sys.exit(130)
