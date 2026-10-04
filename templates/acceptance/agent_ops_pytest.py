"""Load with pytest -p agent_ops_pytest -p no:terminal (PYTHONPATH points here).
Only AssertionError in a test call is behavioral red; fixture errors are not.
The product checkout supplies pytest and all dependencies.
"""
import json
import os
import sys
import pytest


def emit(event):
    event["executionId"] = os.environ.get("AGENT_OPS_ACCEPTANCE_EXECUTION_ID")
    event["phase"] = os.environ.get("AGENT_OPS_ACCEPTANCE_PHASE")
    sys.__stdout__.write(json.dumps(event, ensure_ascii=True) + "\n")
    sys.__stdout__.flush()


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    emit({"type": "test-report", "nodeid": report.nodeid,
          "when": report.when, "outcome": report.outcome,
          "assertion": call.excinfo is not None and call.excinfo.errisinstance(AssertionError),
          "wasxfail": getattr(report, "wasxfail", False),
          "attempts": int(getattr(report, "rerun", 0)) + 1})


def pytest_collectreport(report):
    if report.failed:
        emit({"type": "collection-error", "nodeid": report.nodeid})


def pytest_internalerror(excrepr, excinfo):
    emit({"type": "internal-error"})


def pytest_sessionfinish(session, exitstatus):
    if int(exitstatus) not in (0, 1):
        emit({"type": "session-error", "exitstatus": int(exitstatus)})
    emit({"type": "session-finished", "completed": True,
          "exitstatus": int(exitstatus), "frameworkVersion": pytest.__version__})


if __name__ == "__main__":
    raise SystemExit(pytest.main([*sys.argv[1:], "-p", "no:terminal", "--capture=sys"], plugins=[sys.modules[__name__]]))
