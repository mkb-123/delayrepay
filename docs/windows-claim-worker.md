# Windows claim worker

The Raspberry Pi hosts the dashboard and claim queue. The Windows laptop opens
the operator websites in local Chrome. Each run creates a private SSH tunnel to
the Pi, processes up to five selected claims, then closes the tunnel.

## One-time setup

Open PowerShell in `C:\Users\mitzb\code\delayrepay` and install the browser
library:

```powershell
pnpm install
```

If `pnpm` is unavailable, install current Node.js, then run `npm install`.

Log in once to each operator:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\claim-login.ps1 -Operator VT
.\scripts\windows\claim-login.ps1 -Operator LM
```

For each command, complete login and CAPTCHA in Chrome, check that the saved
season ticket and payment preference are visible, then return to PowerShell and
press Enter. The sessions stay outside Git under:

```text
%LOCALAPPDATA%\DelayRepay\browser-profiles\vt
%LOCALAPPDATA%\DelayRepay\browser-profiles\lm
```

Install the automatic check, which runs every ten minutes while the laptop is
available:

```powershell
.\scripts\windows\setup-claim-worker.ps1
```

## Submit a selected journey

1. Open `http://delayrepay.local`.
2. Find the train actually travelled on and choose **Claim this train**.
3. Leave the item queued until the laptop worker runs, or run it immediately:

   ```powershell
   .\scripts\windows\run-claim-worker.ps1
   ```

4. The first claim for each operator stops at the final confirmation and saves
   a screenshot. Review it in the dashboard and choose **Approve form &
   submit**. Run the worker again; later claims for that operator can submit
   without repeating calibration.
5. A successful submission changes the journey to **Submitted** and stores the
   operator reference when the portal supplies one. Email reconciliation may
   later change it to **Approved**, **Rejected**, or **Paid**.

The worker only handles journeys explicitly selected in the dashboard. It does
not search for or choose claims itself.

## Queue statuses

- **Queued**: waiting for the laptop.
- **Processing**: leased by the current laptop run.
- **Calibration ready**: review the screenshot before approving submission.
- **Submitted**: the portal showed a successful submission or reference.
- **Login needed**: renew that operator's session with `claim-login.ps1`.
- **Check needed**: the portal changed or requested information the worker
  could not safely determine. Review the screenshot; do not assume submission.

## Useful commands

Run now:

```powershell
.\scripts\windows\run-claim-worker.ps1
```

Inspect or start the scheduled task:

```powershell
Get-ScheduledTask -TaskName "MKC EUS Delay Repay Claim Worker"
Start-ScheduledTask -TaskName "MKC EUS Delay Repay Claim Worker"
```

Renew one login:

```powershell
.\scripts\windows\claim-login.ps1 -Operator LM
```

## Troubleshooting

If the runner cannot open the tunnel, first verify the WSL SSH connection:

```powershell
wsl ssh bhakta-pi@pi.local "curl --fail --silent http://127.0.0.1:8765/health"
```

If this asks for a key or fails, repair WSL SSH access to the Pi. Windows
`ssh.exe` uses a different key store, so the scripts deliberately use
`wsl ssh`.

If Chrome reports that the profile is already in use, close the operator login
window and rerun the worker. Normal browsing in another Chrome profile is fine.

If a session expires, rerun `claim-login.ps1` for that operator. Passwords are
entered only on the operator website and are never stored by this repository.

