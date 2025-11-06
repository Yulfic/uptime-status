from __future__ import annotations

import asyncio
import datetime as dt
import json
from contextlib import suppress
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import aiohttp
import yaml
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

try:
	from zoneinfo import ZoneInfo  # py>=3.9
except Exception:  # pragma: no cover
	ZoneInfo = None  # type: ignore

APP_DIR = Path(__file__).parent
DATA_DIR = APP_DIR / "data"
DATA_FILE = DATA_DIR / "checks.ndjson"
CONFIG_PATH = APP_DIR / "config.yaml"
TEMPLATES_DIR = APP_DIR / "templates"
STATIC_DIR = APP_DIR / "static"

# Shift for backend buckets (disabled; we shift only cells on frontend)
SHIFT_HOURS = 0


async def checker_loop() -> None:
	await asyncio.sleep(0.2)
	async with aiohttp.ClientSession() as session:
		while True:
			start_ts = int(dt.datetime.utcnow().timestamp())
			tasks = [check_once(session, s) for s in CONFIG.servers]
			results = await asyncio.gather(*tasks, return_exceptions=False)
			write_tasks = [append_check_result(name, ok, start_ts) for name, ok in results]
			await asyncio.gather(*write_tasks)
			await asyncio.sleep(max(1, CONFIG.check_interval_seconds))


# Lifespan handler to replace deprecated on_event
async def lifespan(app: FastAPI):
	TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
	STATIC_DIR.mkdir(parents=True, exist_ok=True)
	DATA_DIR.mkdir(parents=True, exist_ok=True)
	bg_task = asyncio.create_task(checker_loop())
	try:
		yield
	finally:
		bg_task.cancel()
		with suppress(asyncio.CancelledError):
			await bg_task


app = FastAPI(title="Uptime Dashboard", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


class Config:
	servers: List[Dict[str, str]]
	check_interval_seconds: int
	request_timeout_seconds: int

	@classmethod
	def load(cls) -> "Config":
		with open(CONFIG_PATH, "r", encoding="utf-8") as f:
			raw = yaml.safe_load(f)
		cfg = Config()
		cfg.servers = raw.get("servers", [])
		cfg.check_interval_seconds = int(raw.get("check_interval_seconds", 60))
		cfg.request_timeout_seconds = int(raw.get("request_timeout_seconds", 5))
		return cfg


CONFIG = Config.load()


async def append_check_result(server_name: str, ok: bool, when: Optional[int] = None) -> None:
	"""Append one line of JSON to the checks file."""
	def _write() -> None:
		DATA_DIR.mkdir(parents=True, exist_ok=True)
		payload = {
			"server_name": server_name,
			"ts_utc": when or int(dt.datetime.utcnow().timestamp()),
			"ok": 1 if ok else 0,
		}
		line = json.dumps(payload, ensure_ascii=False)
		with open(DATA_FILE, "a", encoding="utf-8") as f:
			f.write(line + "\n")
	await asyncio.to_thread(_write)


async def read_rows_since(since: int) -> List[Tuple[str, int, int]]:
	"""Read checks from file, keeping only entries newer than 'since'."""
	if not DATA_FILE.exists():
		return []
	def _read() -> List[Tuple[str, int, int]]:
		rows: List[Tuple[str, int, int]] = []
		with open(DATA_FILE, "r", encoding="utf-8") as f:
			for line in f:
				line = line.strip()
				if not line:
					continue
				try:
					obj = json.loads(line)
					if int(obj.get("ts_utc", 0)) >= since:
						rows.append((str(obj.get("server_name")), int(obj.get("ts_utc", 0)), int(obj.get("ok", 0))))
				except Exception:
					# пропускаем битые строки
					continue
		return rows
	return await asyncio.to_thread(_read)


async def check_once(session: aiohttp.ClientSession, server: Dict[str, str]) -> Tuple[str, bool]:
	name = server["name"]
	url = server["url"]
	try:
		timeout = aiohttp.ClientTimeout(total=CONFIG.request_timeout_seconds)
		async with session.get(url, timeout=timeout) as resp:
			ok = 200 <= resp.status < 300
			return name, ok
	except Exception:
		return name, False


async def run_one_round(when_ts: Optional[int] = None) -> List[Tuple[str, bool]]:
	"""Run one check round for all servers and persist results."""
	async with aiohttp.ClientSession() as session:
		results = await asyncio.gather(*[check_once(session, s) for s in CONFIG.servers])
		when = when_ts or int(dt.datetime.utcnow().timestamp())
		await asyncio.gather(*[append_check_result(n, ok, when) for n, ok in results])
		return results


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> Any:
	return templates.TemplateResponse(
		"index.html",
		{
			"request": request,
			"servers": CONFIG.servers,
		},
	)


def period_to_seconds(period: str) -> int:
	if period == "day":
		return 24 * 3600
	if period == "week":
		return 7 * 24 * 3600
	if period == "month":
		return 30 * 24 * 3600
	raise ValueError("invalid period")


@app.get("/api/uptime")
async def api_uptime(period: str = "day") -> JSONResponse:
	# Moscow timezone for all calculations
	msk = ZoneInfo("Europe/Moscow") if ZoneInfo is not None else None
	if msk is None:
		# fallback (UTC window)
		now = int(dt.datetime.utcnow().timestamp())
		window = period_to_seconds(period)
		since = now - window
		rows = await read_rows_since(since)
		buckets: Dict[str, Dict[int, List[int]]] = {}
		for server in [s["name"] for s in CONFIG.servers]:
			buckets[server] = {}
		for server_name, ts_utc, ok in rows:
			hour_bucket = (ts_utc // 3600) * 3600
			buckets.setdefault(server_name, {}).setdefault(hour_bucket, []).append(int(ok))
		start_hour = (since // 3600) * 3600
		end_exclusive = start_hour + window
		result: Dict[str, Any] = {}
		for server in buckets.keys():
			series = []
			total_ok = 0
			total = 0
			for h in range(start_hour, end_exclusive, 3600):
				vals = buckets[server].get(h, [])
				hour_total = len(vals)
				hour_ok = sum(vals)
				pct = (hour_ok / hour_total) if hour_total else None
				series.append({"hour": h, "ok_ratio": pct})
				total_ok += hour_ok
				total += hour_total
			uptime_pct = (total_ok / total * 100.0) if total else None
			result[server] = {"series": series, "uptime_percent": uptime_pct}
		return JSONResponse(result)

	# MSK-aware path
	now_msk = dt.datetime.now(msk)
	if period == "day":
		start_msk = now_msk.replace(hour=0, minute=0, second=0, microsecond=0)
		hours = 24
	elif period == "week":
		start_msk = (now_msk - dt.timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
		hours = 7 * 24
	else:  # month
		start_msk = (now_msk - dt.timedelta(days=29)).replace(hour=0, minute=0, second=0, microsecond=0)
		hours = 30 * 24

	# read only needed rows since the first bucket in UTC
	first_bucket_utc = int(start_msk.astimezone(dt.timezone.utc).timestamp())
	rows = await read_rows_since(first_bucket_utc)

	# group rows into UTC hour buckets
	buckets: Dict[str, Dict[int, List[int]]] = {}
	for server in [s["name"] for s in CONFIG.servers]:
		buckets[server] = {}
	for server_name, ts_utc, ok in rows:
		hour_bucket = (ts_utc // 3600) * 3600
		buckets.setdefault(server_name, {}).setdefault(hour_bucket, []).append(int(ok))

	# build MSK-ordered series
	result: Dict[str, Any] = {}
	for server in buckets.keys():
		series = []
		total_ok = 0
		total = 0
		for i in range(hours):
			h_msk = start_msk + dt.timedelta(hours=i)
			h_utc = h_msk.astimezone(dt.timezone.utc)
			h_bucket = int(h_utc.timestamp())
			vals = buckets[server].get(h_bucket, [])
			hour_total = len(vals)
			hour_ok = sum(vals)
			pct = (hour_ok / hour_total) if hour_total else None
			series.append({"hour": h_bucket, "ok_ratio": pct})
			total_ok += hour_ok
			total += hour_total
		uptime_pct = (total_ok / total * 100.0) if total else None
		result[server] = {"series": series, "uptime_percent": uptime_pct}

	return JSONResponse(result)


@app.post("/api/force-check")
async def api_force_check() -> JSONResponse:
	results = await run_one_round()
	return JSONResponse({"ok": True, "results": [{"server": n, "ok": ok} for n, ok in results]})


if __name__ == "__main__":
	import uvicorn

	uvicorn.run(app, host="0.0.0.0", port=25990, reload=False)

