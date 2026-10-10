# Raspberry Pi deployment

This setup targets Raspberry Pi OS or another Debian-based distribution with systemd. It runs without an AI model.

## What it installs

- `delayrepay.service`: dashboard on port 8765, restarted after failures and boots;
- `delayrepay-collect.timer`: ten-day refresh at 19:00 Monday–Friday;
- `delayrepay-email.timer`: outstanding-claims email at 09:00 Saturday;
- Avahi/mDNS access at `http://<pi-hostname>.local:8765`;
- runtime SQLite and catalogue files in `/var/lib/delayrepay`, separate from Git.

## Migration

Clone the repository on the Pi:

```bash
git clone https://github.com/mkb-123/delayrepay.git
cd delayrepay
cp deploy/raspberry-pi/delayrepay.env.example .env
nano .env
```

Add the RTT credentials and Gmail app password to `.env`. The file is ignored by Git. To give the Pi a stable friendly address, set its hostname before installing:

```bash
sudo timedatectl set-timezone Europe/London
sudo hostnamectl set-hostname delayrepay
sudo reboot
```

After reconnecting, install everything:

```bash
cd delayrepay
chmod +x deploy/raspberry-pi/install.sh scripts/linux/*.sh
./deploy/raspberry-pi/install.sh
```

On the first installation, the script copies the repository's existing SQLite database and catalogue into `/var/lib/delayrepay`. Later Git pulls do not overwrite live claim history.

Open `http://delayrepay.local:8765` from a device on the same network.

## Updating

```bash
cd delayrepay
git pull --ff-only
./deploy/raspberry-pi/install.sh
```

## Operations

```bash
sudo systemctl status delayrepay.service
systemctl list-timers 'delayrepay-*'
sudo systemctl start delayrepay-collect.service
sudo systemctl start delayrepay-email.service
journalctl -u delayrepay.service -n 100
journalctl -u delayrepay-collect.service -n 100
```

Back up `/var/lib/delayrepay/delayrepay.sqlite` regularly. Stop the dashboard before restoring a backup.
