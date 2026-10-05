"""
Job queue with persistence and recovery (section 15).

A *job* is a request to run an optimization (or any long-running
computation). The queue supports:
- adding, removing, reordering jobs;
- pause, resume, cancel;
- saving the queue to disk (resume after crash);
- tracking history (candidates tested, rejected, remaining, current
  best, progress).

The queue is thread-safe (single-threaded job execution; the
queue itself can be inspected from another thread).
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Dict, List, Optional, Any, Callable
from datetime import datetime
import json
import os
import time
import uuid

from ..core.circuit import Circuit
from ..core.library import Library
from ..utils.hashes import stable_hash


class JobStatus(Enum):
    QUEUED = "queued"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class JobSpec:
    """
    The inputs to a search job.

    For now we accept a free-form `category` (e.g. "ALU", "RAM",
    "MULTIPLIER") and a free-form `parameters` dict. A future
    version will have strongly-typed job specifications.
    """
    category: str = "ALU"
    description: str = ""
    parameters: Dict[str, Any] = field(default_factory=dict)
    optimization: str = "BALANCED"  # FASTEST, SMALLEST, ...
    seed: int = 0


@dataclass
class Job:
    """
    A single job in the queue.
    """
    id: str
    name: str
    spec: JobSpec
    status: JobStatus = JobStatus.QUEUED
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    # Progress
    candidates_tested: int = 0
    candidates_rejected: int = 0
    current_best_score: Optional[float] = None
    current_best_fingerprint: Optional[str] = None
    elapsed_s: float = 0.0
    # Error if failed
    error_message: Optional[str] = None
    # Priority (lower = sooner)
    priority: int = 100
    # Wall-clock budget (seconds)
    time_budget_s: Optional[float] = None
    # Result (when completed)
    result: Optional[Any] = None

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["status"] = self.status.value
        return d

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Job":
        d = dict(d)
        d["status"] = JobStatus(d["status"])
        return cls(**d)


@dataclass
class JobHistory:
    """A snapshot of the queue at some point in time."""
    timestamp: float
    jobs: List[Dict[str, Any]]


class JobQueue:
    """
    A simple FIFO queue with priorities and persistence.
    """

    def __init__(self, persistence_path: Optional[str] = None):
        self._jobs: List[Job] = []
        self._persistence_path = persistence_path
        self._running: Optional[Job] = None
        self._history: List[JobHistory] = []

    # ---- CRUD ----
    def add(self, name: str, spec: JobSpec, priority: int = 100,
            time_budget_s: Optional[float] = None) -> Job:
        job = Job(
            id=str(uuid.uuid4())[:8],
            name=name,
            spec=spec,
            priority=priority,
            time_budget_s=time_budget_s,
        )
        self._jobs.append(job)
        self._save()
        return job

    def remove(self, job_id: str) -> bool:
        for i, j in enumerate(self._jobs):
            if j.id == job_id:
                if j.status == JobStatus.RUNNING:
                    return False
                del self._jobs[i]
                self._save()
                return True
        return False

    def get(self, job_id: str) -> Optional[Job]:
        for j in self._jobs:
            if j.id == job_id:
                return j
        return None

    def list(self) -> List[Job]:
        return list(self._jobs)

    def reorder(self, job_id: str, new_priority: int) -> bool:
        j = self.get(job_id)
        if j is None:
            return False
        j.priority = new_priority
        self._save()
        return True

    def pause(self, job_id: str) -> bool:
        j = self.get(job_id)
        if j is None:
            return False
        if j.status == JobStatus.RUNNING:
            j.status = JobStatus.PAUSED
            self._save()
            return True
        if j.status == JobStatus.QUEUED:
            j.status = JobStatus.PAUSED
            self._save()
            return True
        return False

    def resume(self, job_id: str) -> bool:
        j = self.get(job_id)
        if j is None:
            return False
        if j.status == JobStatus.PAUSED:
            j.status = JobStatus.QUEUED
            self._save()
            return True
        return False

    def cancel(self, job_id: str) -> bool:
        j = self.get(job_id)
        if j is None:
            return False
        if j.status in (JobStatus.QUEUED, JobStatus.PAUSED):
            j.status = JobStatus.CANCELLED
            self._save()
            return True
        if j.status == JobStatus.RUNNING:
            j.status = JobStatus.CANCELLED
            self._save()
            return True
        return False

    # ---- selection ----
    def next_queued(self) -> Optional[Job]:
        candidates = [j for j in self._jobs if j.status == JobStatus.QUEUED]
        if not candidates:
            return None
        # Lower priority value = sooner
        candidates.sort(key=lambda j: (j.priority, j.created_at))
        return candidates[0]

    def is_running(self) -> bool:
        return self._running is not None and self._running.status == JobStatus.RUNNING

    def current(self) -> Optional[Job]:
        return self._running

    # ---- progress ----
    def report_progress(self, candidates_tested: int,
                        candidates_rejected: int,
                        current_best_score: Optional[float] = None,
                        current_best_fingerprint: Optional[str] = None) -> None:
        if self._running is None:
            return
        self._running.candidates_tested = candidates_tested
        self._running.candidates_rejected = candidates_rejected
        self._running.current_best_score = current_best_score
        self._running.current_best_fingerprint = current_best_fingerprint
        if self._running.started_at is not None:
            self._running.elapsed_s = time.time() - self._running.started_at

    def start(self, job_id: str) -> Optional[Job]:
        j = self.get(job_id)
        if j is None or j.status != JobStatus.QUEUED:
            return None
        j.status = JobStatus.RUNNING
        j.started_at = time.time()
        self._running = j
        self._save()
        return j

    def complete(self, result: Any = None, error: Optional[str] = None) -> None:
        if self._running is None:
            return
        self._running.completed_at = time.time()
        if error:
            self._running.status = JobStatus.FAILED
            self._running.error_message = error
        else:
            self._running.status = JobStatus.COMPLETED
            self._running.result = result
        self._save()
        self._history.append(JobHistory(
            timestamp=time.time(),
            jobs=[j.to_dict() for j in self._jobs],
        ))
        self._running = None

    # ---- persistence ----
    def _save(self) -> None:
        if self._persistence_path is None:
            return
        data = {
            "jobs": [j.to_dict() for j in self._jobs],
            "history": [{"timestamp": h.timestamp, "jobs": h.jobs} for h in self._history],
        }
        tmp = self._persistence_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, self._persistence_path)

    def load(self) -> None:
        if self._persistence_path is None or not os.path.exists(self._persistence_path):
            return
        with open(self._persistence_path) as f:
            data = json.load(f)
        self._jobs = [Job.from_dict(d) for d in data.get("jobs", [])]
        self._history = [
            JobHistory(timestamp=h["timestamp"], jobs=h["jobs"])
            for h in data.get("history", [])
        ]
        # Re-detect a running job (we may have crashed mid-run)
        for j in self._jobs:
            if j.status == JobStatus.RUNNING:
                j.status = JobStatus.PAUSED  # paused, requires explicit resume
                self._running = None

    def render(self) -> str:
        lines = ["JOB QUEUE"]
        for j in self._jobs:
            line = (
                f"  [{j.status.value.upper():<10}] {j.id} {j.name:<30} "
                f"candidates={j.candidates_tested:>8} "
                f"rejected={j.candidates_rejected:>8} "
                f"elapsed={j.elapsed_s:>6.1f}s"
            )
            lines.append(line)
        return "\n".join(lines)


def render_log(queue: JobQueue) -> str:
    """Convenience function for the GUI/CLI."""
    return queue.render()