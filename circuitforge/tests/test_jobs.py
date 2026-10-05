"""Tests for the job queue."""

import os
import tempfile
import unittest

from circuitforge.jobs import JobQueue, Job, JobStatus, JobSpec


class TestJobQueue(unittest.TestCase):

    def setUp(self):
        self.queue = JobQueue()

    def test_add_and_list(self):
        j = self.queue.add("Test ALU", JobSpec(category="ALU"), priority=100)
        self.assertEqual(len(self.queue.list()), 1)
        self.assertEqual(j.status, JobStatus.QUEUED)

    def test_priority_order(self):
        j1 = self.queue.add("Low", JobSpec(category="X"), priority=100)
        j2 = self.queue.add("High", JobSpec(category="X"), priority=10)
        nxt = self.queue.next_queued()
        self.assertEqual(nxt.id, j2.id)

    def test_start_complete(self):
        j = self.queue.add("Test", JobSpec(category="X"))
        self.queue.start(j.id)
        self.assertEqual(j.status, JobStatus.RUNNING)
        self.queue.complete(result={"best": 42})
        self.assertEqual(j.status, JobStatus.COMPLETED)
        self.assertEqual(j.result, {"best": 42})

    def test_pause_resume(self):
        j = self.queue.add("Test", JobSpec(category="X"))
        self.queue.start(j.id)
        self.queue.pause(j.id)
        self.assertEqual(j.status, JobStatus.PAUSED)
        self.queue.resume(j.id)
        self.assertEqual(j.status, JobStatus.QUEUED)

    def test_cancel(self):
        j = self.queue.add("Test", JobSpec(category="X"))
        self.queue.cancel(j.id)
        self.assertEqual(j.status, JobStatus.CANCELLED)

    def test_progress_reporting(self):
        j = self.queue.add("Test", JobSpec(category="X"))
        self.queue.start(j.id)
        self.queue.report_progress(100, 50, 0.95, "fingerprint_xyz")
        self.assertEqual(j.candidates_tested, 100)
        self.assertEqual(j.candidates_rejected, 50)
        self.assertEqual(j.current_best_score, 0.95)
        self.assertEqual(j.current_best_fingerprint, "fingerprint_xyz")

    def test_persistence(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            path = f.name
        try:
            q1 = JobQueue(persistence_path=path)
            j = q1.add("Persist", JobSpec(category="X"), priority=50)
            q1._save()  # explicit save
            # Re-load
            q2 = JobQueue(persistence_path=path)
            q2.load()
            self.assertEqual(len(q2.list()), 1)
            self.assertEqual(q2.list()[0].name, "Persist")
        finally:
            os.unlink(path)

    def test_remove(self):
        j = self.queue.add("Test", JobSpec(category="X"))
        self.assertTrue(self.queue.remove(j.id))
        self.assertEqual(len(self.queue.list()), 0)

    def test_remove_running_fails(self):
        j = self.queue.add("Test", JobSpec(category="X"))
        self.queue.start(j.id)
        self.assertFalse(self.queue.remove(j.id))


if __name__ == "__main__":
    unittest.main()