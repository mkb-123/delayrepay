import unittest

from delayrepay.domain.assessment import assess


def svc(service_id, operator, name, dep, arr, actual_dep, actual_arr, raw):
    return {
        "serviceId": service_id, "operatorCode": operator, "operatorName": name, "direction": "EVENING",
        "origin": "EUS", "destination": "MKC", "scheduledDeparture": dep, "scheduledArrival": arr,
        "actualDeparture": actual_dep, "actualArrival": actual_arr, "rawDelayMinutes": raw, "cancelled": False,
    }


class AlternativeTrainTests(unittest.TestCase):
    """Each operator is measured only against its own trains (the user's rule)."""

    def setUp(self):
        self.avanti = svc("a", "VT", "Avanti West Coast", "2026-10-07T18:16:00", "2026-10-07T18:51:00",
                          "2026-10-07T18:42:00", "2026-10-07T19:17:00", 26)
        self.lnr = svc("b", "LM", "London Northwestern Railway", "2026-10-07T18:19:00", "2026-10-07T18:56:00",
                       "2026-10-07T18:19:00", "2026-10-07T18:57:00", 1)

    def test_another_operators_train_does_not_affect_an_avanti_claim(self):
        result = assess(self.avanti, [self.avanti, self.lnr])
        self.assertEqual(result["status"], "POTENTIAL")
        self.assertFalse(result["likelyRejected"])

    def test_a_better_train_from_the_same_operator_flags_likely_rejected(self):
        later_avanti = svc("e", "VT", "Avanti West Coast", "2026-10-07T18:23:00", "2026-10-07T18:58:00",
                           "2026-10-07T18:23:00", "2026-10-07T18:59:00", 1)
        result = assess(self.avanti, [self.avanti, later_avanti])
        self.assertTrue(result["likelyRejected"])
        self.assertEqual(result["status"], "NEEDS_REVIEW")
        self.assertEqual(result["effectiveDelayMinutes"], 8)

    def test_no_alternative_stays_potential(self):
        result = assess(self.avanti, [self.avanti])
        self.assertEqual(result["status"], "POTENTIAL")
        self.assertFalse(result["likelyRejected"])

    def test_lnr_still_compares_only_its_own_operator(self):
        late_lnr = dict(self.lnr, serviceId="c", scheduledDeparture="2026-10-07T17:46:00", scheduledArrival="2026-10-07T18:18:00",
                        actualDeparture="2026-10-07T18:12:00", actualArrival="2026-10-07T18:46:00", rawDelayMinutes=28)
        fast_avanti = dict(self.avanti, serviceId="d", scheduledDeparture="2026-10-07T17:53:00", actualDeparture="2026-10-07T17:53:00",
                           scheduledArrival="2026-10-07T18:28:00", actualArrival="2026-10-07T18:29:00", rawDelayMinutes=1)
        result = assess(late_lnr, [late_lnr, fast_avanti])
        self.assertEqual(result["status"], "POTENTIAL")


class CancelledTrainTests(unittest.TestCase):
    """A cancelled train takes its delay from the next train of the same operator."""

    def make(self, next_actual_arrival):
        cancelled = dict(svc("c", "LM", "London Northwestern Railway", "2026-10-15T06:49:00", "2026-10-15T07:24:00", None, None, None), cancelled=True, direction="MORNING")
        following = dict(svc("n", "LM", "London Northwestern Railway", "2026-10-15T06:56:00", "2026-10-15T07:38:00", "2026-10-15T06:56:00", next_actual_arrival, 0), direction="MORNING")
        return cancelled, following

    def test_long_gap_to_next_train_is_a_claim(self):
        cancelled, following = self.make("2026-10-15T07:45:00")  # due 07:24, next arrived 07:45
        result = assess(cancelled, [cancelled, following])
        self.assertEqual(result["status"], "POTENTIAL")
        self.assertEqual(result["effectiveDelayMinutes"], 21)

    def test_short_gap_is_not_a_claim(self):
        cancelled, following = self.make("2026-10-15T07:30:00")
        result = assess(cancelled, [cancelled, following])
        self.assertEqual(result["status"], "NO_CLAIM")
        self.assertEqual(result["effectiveDelayMinutes"], 6)

    def test_same_time_twin_that_ran_counts_as_the_next_train(self):
        cancelled, _ = self.make("2026-10-15T07:45:00")
        twin = dict(svc("t", "LM", "London Northwestern Railway", "2026-10-15T06:49:00", "2026-10-15T07:24:00", "2026-10-15T06:49:00", "2026-10-15T07:22:00", 0), direction="MORNING")
        result = assess(cancelled, [cancelled, twin])
        self.assertEqual(result["status"], "NO_CLAIM")
        self.assertEqual(result["effectiveDelayMinutes"], 0)

    def test_no_later_train_data_waits_for_review(self):
        cancelled, _ = self.make("2026-10-15T07:45:00")
        result = assess(cancelled, [cancelled])
        self.assertEqual(result["status"], "NEEDS_REVIEW")
        self.assertIn("no later train", result["explanation"])


if __name__ == "__main__":
    unittest.main()
