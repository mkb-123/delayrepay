# TODO

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
