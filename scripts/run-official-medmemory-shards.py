#!/usr/bin/env python3
"""Run isolated MedMemoryBench persona shards with checkpoint-aware recovery.

The supervisor complements two already-running Persona 1 jobs by starting
Persona 3/5/7 for A-Mem and Letta. A stopped shard waits until another active
job completes and frees a slot, then resumes from its checkpoint. Provider
authentication/quota failures and unsafe local resource conditions still pause
everything to avoid retry loops and duplicate charges.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import IO

from baseline_result_integrity import newest_valid_result


METHODS = ("amem", "letta")
FATAL_LOG_MARKERS = (
    "insufficient_quota",
    "insufficient balance",
    "余额不足",
    "invalid api key",
    "invalid_api_key",
    "authenticationerror",
    "unauthorized",
    "http/1.1 401",
    "http/1.1 402",
)


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--runner", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--existing-root", type=Path, required=True)
    parser.add_argument("--embedding-model", type=Path, required=True)
    parser.add_argument(
        "--methods",
        default=",".join(METHODS),
        help="Comma-separated baseline methods to run (amem,letta)",
    )
    parser.add_argument("--personas", default="3,5,7")
    parser.add_argument("--model", default="qwen3.7-plus")
    parser.add_argument("--base-url", default="https://api.openai-proxy.org/v1")
    parser.add_argument("--interval", type=int, default=15)
    parser.add_argument("--minimum-free-gb", type=float, default=5.0)
    parser.add_argument("--restart-cooldown-seconds", type=int, default=60)
    parser.add_argument("--max-restarts", type=int, default=3)
    parser.add_argument(
        "--adopt-status",
        type=Path,
        default=None,
        help="Adopt still-running shard PIDs from a previous supervisor status file",
    )
    return parser.parse_args()


@dataclass
class Job:
    method: str
    persona: int
    output_dir: Path
    log_path: Path
    log_handle: IO[bytes]
    checkpoint_path: Path
    pid: int | None = None
    process: subprocess.Popen[bytes] | None = None
    state: str = "pending"
    restart_count: int = 0
    wait_for_generation: int = 0
    restart_not_before: float = 0.0
    last_exit: int | None = None
    last_reason: str | None = None
    log_offset: int = 0

    @property
    def name(self) -> str:
        return f"{self.method}-persona-{self.persona}"

    def alive(self) -> bool:
        if self.pid is None:
            return False
        if self.process is not None:
            return self.process.poll() is None
        try:
            os.kill(self.pid, 0)
        except (ProcessLookupError, PermissionError):
            return False
        return True

    def return_code(self) -> int | None:
        if self.process is None:
            return None
        return self.process.poll()


class Supervisor:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.jobs: list[Job] = []
        self.stopping = False
        self.capacity_generation = 0
        self.restart_generation_cursor = 0
        self.external_p1_stopped = {method: False for method in args.methods}
        # Separate single-method supervisors may share one output tree. Keep
        # their control files independent so an A-Mem run cannot overwrite a
        # Letta resume status (or vice versa).
        suffix = "" if tuple(args.methods) == METHODS else f"-{'-'.join(args.methods)}"
        self.status_path = args.output_root / f"supervisor{suffix}-status.json"
        self.event_log_path = args.output_root / f"supervisor{suffix}.log"

    def event(self, message: str) -> None:
        line = f"[{now()}] {message}"
        print(line, flush=True)
        with self.event_log_path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")

    def build_command(self, method: str, persona: int, output_dir: Path) -> list[str]:
        command = [
            sys.executable,
            "-u",
            str(self.args.runner),
            "--repo",
            str(self.args.repo),
            "--method",
            method,
            "--personas",
            str(persona),
            "--model",
            self.args.model,
            "--judge-model",
            self.args.model,
            "--base-url",
            self.args.base_url,
            "--embedding-model",
            str(self.args.embedding_model),
            "--output-dir",
            str(output_dir),
            "--resume",
            "--quiet",
        ]
        if method == "amem":
            command.extend(("--amem-request-timeout-seconds", "300"))
        return command

    def make_job(self, method: str, persona: int) -> Job:
        output_dir = self.args.output_root / method / f"persona-{persona}"
        output_dir.mkdir(parents=True, exist_ok=True)
        log_path = output_dir / "process.log"
        log_handle = log_path.open("ab", buffering=0)
        checkpoint_path = (
            output_dir
            / "checkpoints"
            / "medmemorybench"
            / f"{method}_{self.args.model}"
            / "checkpoint.json"
        )
        return Job(method, persona, output_dir, log_path, log_handle, checkpoint_path)

    def launch_job(self, job: Job, *, resumed: bool) -> None:
        if resumed:
            job.log_handle.write(
                f"\n[{now()}] supervisor restarting from checkpoint\n".encode("utf-8")
            )
        env = os.environ.copy()
        env["COMPOSIO_DISABLE_VERSION_CHECK"] = "true"
        env.setdefault("LLM_MAX_RETRIES", "3")
        job.log_offset = job.log_path.stat().st_size if job.log_path.exists() else 0
        process = subprocess.Popen(
            self.build_command(job.method, job.persona, job.output_dir),
            cwd=self.args.runner.parent.parent,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=job.log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        job.process = process
        job.pid = process.pid
        job.state = "running"
        job.last_exit = None
        job.last_reason = None
        self.event(
            f"{'restarted' if resumed else 'started'} {job.method} Persona {job.persona}, "
            f"pid={process.pid}, restart={job.restart_count}/{self.args.max_restarts}"
        )

    def start_or_adopt_jobs(self) -> None:
        personas = [int(value.strip()) for value in self.args.personas.split(",") if value.strip()]
        if not personas or any(persona <= 0 for persona in personas):
            raise SystemExit("--personas must contain positive integers")
        if not (os.environ.get("CAREHARNESS_RUN_KEY") or os.environ.get("OPENAI_API_KEY")):
            raise SystemExit("supervisor has no inherited CAREHARNESS_RUN_KEY or OPENAI_API_KEY")

        adopted: dict[tuple[str, int], dict] = {}
        if self.args.adopt_status and self.args.adopt_status.exists():
            try:
                previous = json.loads(self.args.adopt_status.read_text(encoding="utf-8"))
                adopted = {
                    (item["method"], int(item["persona"])): item
                    for item in previous.get("jobs", [])
                }
                self.external_p1_stopped.update(previous.get("existing_persona_1_stopped", {}))
                self.capacity_generation = int(previous.get("capacity_generation", 0))
                self.restart_generation_cursor = self.capacity_generation
            except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
                adopted = {}

        for method in self.args.methods:
            for persona in personas:
                job = self.make_job(method, persona)
                prior = adopted.get((method, persona), {})
                prior_pid = prior.get("pid")
                if isinstance(prior_pid, int) and prior_pid > 0:
                    job.pid = prior_pid
                    job.state = "running"
                    job.restart_count = int(prior.get("restart_count", 0))
                    job.log_offset = job.log_path.stat().st_size if job.log_path.exists() else 0
                    if job.alive():
                        self.jobs.append(job)
                        self.event(f"adopted {job.name}, pid={job.pid}")
                        continue
                    job.pid = None
                self.jobs.append(job)
                self.launch_job(job, resumed=job.checkpoint_path.exists())

    @staticmethod
    def read_checkpoint(path: Path) -> dict:
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def result_exists(self, job: Job) -> bool:
        valid_path, _audit = newest_valid_result(
            job.output_dir,
            job.method,
            self.args.model,
        )
        return valid_path is not None

    def fatal_log_error(self, job: Job) -> str | None:
        if not job.log_path.exists():
            return None
        try:
            with job.log_path.open("rb") as handle:
                handle.seek(job.log_offset)
                content = handle.read()
                job.log_offset = handle.tell()
        except OSError:
            return None
        lowered = content.decode("utf-8", errors="replace").lower()
        return next((marker for marker in FATAL_LOG_MARKERS if marker in lowered), None)

    def stop_external_p1(self, method: str) -> None:
        if self.external_p1_stopped[method]:
            return
        if method == "amem":
            command = ["screen", "-S", "careharness-baselines", "-p", "0", "-X", "kill"]
        else:
            command = ["screen", "-S", "careharness-letta-fixed", "-X", "quit"]
        result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.external_p1_stopped[method] = True
        self.capacity_generation += 1
        self.event(
            f"stopped old serial {method} window after Persona 1, status={result.returncode}; "
            f"capacity_generation={self.capacity_generation}"
        )

    def monitor_external_p1(self) -> str | None:
        for method in self.args.methods:
            if self.external_p1_stopped[method]:
                continue
            checkpoint = (
                self.args.existing_root
                / method
                / "checkpoints"
                / "medmemorybench"
                / f"{method}_{self.args.model}"
                / "checkpoint.json"
            )
            data = self.read_checkpoint(checkpoint)
            if data.get("status") == "failed" or data.get("last_error"):
                return f"existing Persona 1 {method} failed: {data.get('last_error') or 'checkpoint failed'}"
            completed = {int(value) for value in data.get("completed_personas", [])}
            current_persona = data.get("current_persona_id")
            if 1 in completed or (current_persona is not None and int(current_persona) != 1):
                self.stop_external_p1(method)
        return None

    def queue_restart(self, job: Job, reason: str) -> None:
        exit_status = job.return_code()
        job.state = "waiting_for_capacity"
        job.last_exit = exit_status
        job.last_reason = reason
        job.process = None
        job.pid = None
        other_running = any(other is not job and other.alive() for other in self.jobs)
        if other_running:
            self.restart_generation_cursor = max(
                self.restart_generation_cursor,
                self.capacity_generation,
            ) + 1
            job.wait_for_generation = self.restart_generation_cursor
        else:
            job.wait_for_generation = self.capacity_generation
        job.restart_not_before = time.monotonic() + self.args.restart_cooldown_seconds
        self.event(
            f"queued {job.name} for checkpoint restart after capacity generation "
            f"{job.wait_for_generation}: {reason}"
        )

    def restart_waiting_jobs(self) -> str | None:
        for job in self.jobs:
            if job.state != "waiting_for_capacity":
                continue
            if self.capacity_generation < job.wait_for_generation:
                continue
            if time.monotonic() < job.restart_not_before:
                continue
            if job.restart_count >= self.args.max_restarts:
                return f"{job.name} exceeded {self.args.max_restarts} checkpoint restarts"
            job.restart_count += 1
            self.launch_job(job, resumed=True)
        return None

    def mark_completed(self, job: Job) -> None:
        if job.state == "completed":
            return
        exit_status = job.return_code()
        job.state = "completed"
        job.last_exit = exit_status
        job.process = None
        job.pid = None
        self.capacity_generation += 1
        self.event(f"completed {job.name}; capacity_generation={self.capacity_generation}")

    def write_status(self, state: str, reason: str | None = None) -> None:
        jobs = []
        for job in self.jobs:
            data = self.read_checkpoint(job.checkpoint_path)
            jobs.append(
                {
                    "method": job.method,
                    "persona": job.persona,
                    "pid": job.pid,
                    "state": job.state,
                    "process_status": job.return_code(),
                    "checkpoint_status": data.get("status"),
                    "completed_queries": data.get("completed_query_count", 0),
                    "total_queries": data.get("total_queries"),
                    "current_persona_id": data.get("current_persona_id"),
                    "updated_at": data.get("updated_at"),
                    "restart_count": job.restart_count,
                    "wait_for_generation": job.wait_for_generation,
                    "last_reason": job.last_reason,
                    "output_dir": str(job.output_dir),
                }
            )
        payload = {
            "state": state,
            "reason": reason,
            "updated_at": now(),
            "capacity_generation": self.capacity_generation,
            "existing_persona_1_stopped": self.external_p1_stopped,
            "jobs": jobs,
        }
        temporary = self.status_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(self.status_path)

    def pause_all(self, reason: str) -> None:
        if self.stopping:
            return
        self.stopping = True
        self.event(f"pausing all jobs: {reason}")
        for job in self.jobs:
            if job.alive() and job.pid is not None:
                try:
                    os.killpg(job.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        for method in self.args.methods:
            self.stop_external_p1(method)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and any(job.alive() for job in self.jobs):
            time.sleep(0.5)
        for job in self.jobs:
            if job.alive() and job.pid is not None:
                try:
                    os.killpg(job.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            job.state = "paused" if job.state != "completed" else job.state
            job.log_handle.close()
        self.write_status("paused", reason)

    def monitor(self) -> int:
        self.write_status("running")
        while True:
            free_gb = shutil.disk_usage(self.args.output_root).free / (1024**3)
            if free_gb < self.args.minimum_free_gb:
                self.pause_all(f"free disk space {free_gb:.2f} GB is below threshold")
                return 2

            external_error = self.monitor_external_p1()
            if external_error:
                self.pause_all(external_error)
                return 2

            for job in self.jobs:
                if job.state != "running":
                    continue
                marker = self.fatal_log_error(job)
                if marker:
                    self.pause_all(f"{job.name} emitted fatal provider error: {marker}")
                    return 2
                if job.alive():
                    continue

                checkpoint = self.read_checkpoint(job.checkpoint_path)
                if checkpoint.get("status") == "completed" or self.result_exists(job):
                    self.mark_completed(job)
                    continue
                return_code = job.return_code()
                detail = checkpoint.get("last_error") or f"process exited with status {return_code}"
                self.queue_restart(job, str(detail))

            restart_error = self.restart_waiting_jobs()
            if restart_error:
                self.pause_all(restart_error)
                return 2

            self.write_status("running")
            if all(job.state == "completed" for job in self.jobs):
                for job in self.jobs:
                    job.log_handle.close()
                self.write_status("completed")
                self.event("all Persona 3/5/7 shards completed")
                return 0
            time.sleep(max(self.args.interval, 5))


def main() -> int:
    args = parse_args()
    args.methods = tuple(dict.fromkeys(
        value.strip().lower() for value in args.methods.split(",") if value.strip()
    ))
    if not args.methods or any(method not in METHODS for method in args.methods):
        raise SystemExit("--methods must contain amem, letta, or both")
    args.repo = args.repo.resolve()
    args.runner = args.runner.resolve()
    args.output_root = args.output_root.resolve()
    args.existing_root = args.existing_root.resolve()
    args.embedding_model = args.embedding_model.resolve()
    if args.adopt_status is not None:
        args.adopt_status = args.adopt_status.resolve()
    args.output_root.mkdir(parents=True, exist_ok=True)

    supervisor = Supervisor(args)

    def stop_from_signal(signum: int, _frame: object) -> None:
        supervisor.pause_all(f"supervisor received signal {signum}")
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, stop_from_signal)
    signal.signal(signal.SIGINT, stop_from_signal)
    supervisor.start_or_adopt_jobs()
    return supervisor.monitor()


if __name__ == "__main__":
    raise SystemExit(main())
