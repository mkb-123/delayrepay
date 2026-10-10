# TODO

## Priority order

### 1. Activate and test the Saturday email

- Complete either the OAuth migration below or temporarily configure a Gmail app password.
- Send a real test email to `Mitzbhakta@gmail.com`.
- Confirm the email omits acknowledged days and already claimed journeys.
- Confirm the Windows task succeeds unattended and records a useful failure in its log.

### 2. Migrate to the Raspberry Pi

- Set the Pi hostname to `delayrepay` and timezone to `Europe/London`.
- Clone the repository and configure its ignored `.env`.
- Run `deploy/raspberry-pi/install.sh`.
- Verify `http://delayrepay.local:8765` from the phone.
- Confirm the existing SQLite claim history was copied into `/var/lib/delayrepay`.
- Manually run the collection and email systemd services once.
- Confirm both timers survive a reboot and catch up after the Pi was powered off.

### 3. Add automatic SQLite backups on the Pi

- Create backups without copying an actively changing SQLite file directly; use SQLite's backup API from Python.
- Keep several dated local backups outside the repository.
- Add a systemd backup timer and retention policy.
- Document and test a restore procedure.

### 4. Add versioned database migrations

The current schema is created with `CREATE TABLE IF NOT EXISTS` and always reports `user_version=1`. Replace this with ordered migrations before more schema changes are added. Existing Windows and Pi databases must upgrade without losing services, claims, acknowledgements, or manual decisions.

### 5. Add the deferred automated tests

The workflow was intentionally built without a committed test suite while requirements were changing. Once the claim workflow is stable, add focused tests for:

- delay-band boundaries: 15, 30, 60, and 90 minutes;
- same-operator alternative selection;
- cancellation and incomplete-data decisions;
- claimed-time preference within the same delay band;
- one claim per date and direction, including Undo;
- day acknowledgement persistence;
- duplicate/idempotent collection;
- scheduler latest-weekday and ten-day lookback behaviour;
- email filtering and rendering without network access.

### 6. Operational rule and timetable maintenance

- Re-check Avanti and LNR/West Midlands Delay Repay sources periodically and update each rule's version and verification date.
- Confirm whether services branded West Midlands Railway should continue using the shared `LM` rule definition and claim destination.
- Rediscover the service catalogue after timetable changes rather than on every collection.
- Record the last timetable discovery date visibly in the dashboard or operations view.

### Optional hardening

- Add authentication before exposing the dashboard beyond the trusted home LAN.
- Use Tailscale or another private VPN for access away from home rather than public port forwarding.
- Add a dashboard health panel showing the last successful collection, next scheduled run, and most recent error.

## Replace Gmail app-password SMTP with OAuth 2.0

The Saturday email currently sends through `smtp.gmail.com` using `GMAIL_SMTP_USER` and `GMAIL_APP_PASSWORD`. Replace this with the Gmail API and OAuth 2.0 so no Gmail password or app password is stored.

### Current implementation

- Email rendering and SMTP sending: `python/delayrepay/emailing.py`
- CLI command: `delayrepay email-summary`
- Windows launcher/task: `scripts/weekly-email.ps1` and `scripts/setup-weekly-email-task.ps1`
- Raspberry Pi timer: `deploy/raspberry-pi/install.sh`
- Saturday schedule: 09:00, with a ten-day lookback ending on the latest weekday
- Recipient: configured through `DELAYREPAY_EMAIL_TO`

### Required design

1. Use the Gmail API `users.messages.send` method.
2. Request only the narrow `https://www.googleapis.com/auth/gmail.send` scope.
3. Add a one-time command such as `delayrepay gmail-authorize` using Google's Desktop app OAuth flow.
4. Read the downloaded OAuth client file from a configurable path, for example `GMAIL_OAUTH_CLIENT_FILE`.
5. Store the resulting refresh-token file outside Git at a configurable path, for example `GMAIL_OAUTH_TOKEN_FILE`.
6. Refresh short-lived access tokens automatically during unattended Windows and Raspberry Pi runs.
7. Preserve the existing `email-summary --dry-run` behaviour.
8. Remove `GMAIL_APP_PASSWORD` after OAuth sending has been tested successfully.
9. Update `.env.example`, the main README, and the Raspberry Pi deployment guide.
10. Keep OAuth client and token JSON files ignored by Git and restrict their filesystem permissions on the Pi.

### Google Cloud setup

- Enable the Gmail API in a Google Cloud project.
- Configure an External OAuth consent screen.
- Add `Mitzbhakta@gmail.com` as a test user during setup.
- Create an OAuth client with application type **Desktop app**.
- Download the client JSON locally; never commit it.
- Move the OAuth app to **In production** before relying on the weekly automation. Gmail refresh tokens issued while an External app remains in Testing normally expire after seven days.

Official references:

- https://developers.google.com/workspace/gmail/api/quickstart/python
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
- https://support.google.com/cloud/answer/15549945

### Suggested dependencies

Add compatible versions of:

- `google-api-python-client`
- `google-auth-httplib2`
- `google-auth-oauthlib`

### Migration and Pi notes

- Perform the first browser authorization on a machine with a browser.
- Copy the resulting client and token files securely to the Pi, outside the repository.
- The systemd email service already loads `.env`; configure the two credential paths there.
- Ensure the service user can read the files, preferably mode `0600`.
- Do not log access tokens, refresh tokens, client secrets, or full credential objects.

### Acceptance criteria

- `delayrepay gmail-authorize` completes one-time browser consent and writes an ignored token file.
- `delayrepay email-summary --dry-run` makes no network call.
- `delayrepay email-summary` sends the existing concise summary through the Gmail API.
- A second send succeeds without opening a browser.
- The Windows task and Raspberry Pi timer work unattended after reboot.
- No Gmail password, app password, OAuth client secret, access token, or refresh token is committed or logged.
