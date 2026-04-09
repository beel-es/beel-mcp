from __future__ import annotations

import pytest

from beel_mcp.policies.nif_policy import evaluate_nif_result
from beel_mcp.policies.state_machine import PolicyViolation, assert_action_allowed


def test_nif_policy_pending_can_proceed():
    policy = evaluate_nif_result("PENDING")
    assert policy["can_proceed"] is True


def test_issue_invoice_requires_draft():
    with pytest.raises(PolicyViolation):
        assert_action_allowed("issue_invoice", "SENT")


def test_mark_paid_requires_sent():
    with pytest.raises(PolicyViolation):
        assert_action_allowed("mark_invoice_paid", "ISSUED")
