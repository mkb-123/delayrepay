import unittest

from delayrepay.domain.assessment import assess


def svc(service_id, operator, name, dep, arr, actual_dep, actual_arr, raw):
    return {
        "serviceId": service_id, "operatorCode": operator, "operatorName": name, "direction": "EVENING",
        "origin": "EUS", "destination": "MKC", "scheduledDeparture": dep, "scheduledArrival": arr,
        "actualDeparture": actual_dep, "actualArrival": actual_arr, "rawDelayMinutes": raw, "cancelled": False,
    }


class AlternativeTrainTests(unittest.TestCase):
    """Regression for the Avanti rejections of 7 and 8 Oct 2026: the 18:19 LNR train beat the late 18:16 Avanti."""

    def setUp(self):
        self.avanti = svc("a", "VT", "Avanti West Coast", "2026-10-07T18:16:00", "2026-10-07T18:51:00",
                          "2026-10-07T18:42:00", "2026-10-07T19:17:00", 26)
        self.lnr = svc("b", "LM", "London Northwestern Railway", "2026-10-07T18:19:00", "2026-10-07T18:56:00",
                       "2026-10-07T18:19:00", "2026-10-07T18:57:00", 1)

    def test_other_operator_alternative_marks_avanti_claim_likely_rejected(self):
        result = assess(self.avanti, [self.avanti, self.lnr])
        self.assertTrue(result["likelyRejected"])
        self.assertEqual(result["status"], "NEEDS_REVIEW")
        self.assertEqual(result["effectiveDelayMinutes"], 6)

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

    def test_no_later_train_data_waits_for_review(self):
        cancelled, _ = self.make("2026-10-15T07:45:00")
        result = assess(cancelled, [cancelled])
        self.assertEqual(result["status"], "NEEDS_REVIEW")
        self.assertIn("no later train", result["explanation"])


if __name__ == "__main__":
    unittest.main()
