RULES = {
    "VT": {
        "operatorName": "Avanti West Coast", "minimumDelay": 15, "ruleVersion": "VT-2026-09-25-v1",
        "sourceUrl": "https://www.avantiwestcoast.co.uk/help-and-support/delay-repay", "verifiedAt": "2026-09-25",
        "claimUrl": "https://delayrepay.avantiwestcoast.co.uk/",
        # Each operator is measured only against its own trains (the user's rule, 23 Oct 2026). Set
        # "alternativeScope": "ANY_OPERATOR" to compare against every operator's trains instead.
        "alternativeScope": "SAME_OPERATOR",
    },
    "LM": {
        "operatorName": "London Northwestern Railway", "minimumDelay": 15, "ruleVersion": "LM-2026-09-25-v1",
        "sourceUrl": "https://www.londonnorthwesternrailway.co.uk/about-us/delay-repay", "verifiedAt": "2026-09-25",
        "claimUrl": "https://londonnorthwesternrailway.delayrepaycompensation.com/",
    },
}
