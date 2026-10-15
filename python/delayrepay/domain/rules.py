RULES = {
    "VT": {
        "operatorName": "Avanti West Coast", "minimumDelay": 15, "ruleVersion": "VT-2026-09-25-v1",
        "sourceUrl": "https://www.avantiwestcoast.co.uk/help-and-support/delay-repay", "verifiedAt": "2026-09-25",
        "claimUrl": "https://delayrepay.avantiwestcoast.co.uk/",
        # Learned from rejected claims (7 and 8 Oct 2026): Avanti measures the delay against the best
        # alternative the ticket allows, including other operators' trains.
        "alternativeScope": "ANY_OPERATOR",
    },
    "LM": {
        "operatorName": "London Northwestern Railway", "minimumDelay": 15, "ruleVersion": "LM-2026-09-25-v1",
        "sourceUrl": "https://www.londonnorthwesternrailway.co.uk/about-us/delay-repay", "verifiedAt": "2026-09-25",
        "claimUrl": "https://londonnorthwesternrailway.delayrepaycompensation.com/",
    },
}
