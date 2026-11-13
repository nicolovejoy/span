# Raspberry Pi Setup for SPAN Monitoring

## Hardware Needed

- Raspberry Pi 4 (2GB+ RAM) or Pi 5
- 32GB+ microSD card (64GB recommended)
- USB-C power supply (5V 3A)
- Ethernet cable (recommended) or WiFi

## Initial Pi Setup

1. Download Raspberry Pi Imager: https://www.raspberrypi.com/software/

2. Flash "Raspberry Pi OS Lite (64-bit)" to SD card
   - Click gear icon for advanced options
   - Enable SSH
   - Set username/password
   - Configure WiFi if not using ethernet

3. Boot the Pi and SSH in:
   ```bash
   ssh pi@raspberrypi.local
   ```

4. Update system:
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```

5. Install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   logout
   ```

6. SSH back in and verify:
   ```bash
   docker --version
   ```

## Deploy SPAN Monitoring Stack

1. Clone the repo:
   ```bash
   git clone https://github.com/nicolovejoy/span.git
   cd span/pi
   ```

2. Render `pi/.env` from 1Password. Run this on the laptop, not the Pi (the
   Pi has no `op`); it reads `pi/.env.tpl` and never needs hand-editing:
   ```bash
   pi/render_env.sh
   ```

3. Start the stack:
   ```bash
   docker compose up -d
   ```

4. Check logs:
   ```bash
   docker compose logs -f collector
   ```

## Access Dashboards

- **Grafana**: http://raspberrypi.local:3000 (admin / spanmonitor123)
- **InfluxDB**: http://raspberrypi.local:8086 (admin / spanmonitor123)

## Configure Grafana

1. Log into Grafana
2. Go to Connections → Data Sources → Add data source
3. Select InfluxDB
4. Configure:
   - Query Language: Flux
   - URL: http://influxdb:8086
   - Organization: home
   - Token: span-local-token
   - Default Bucket: span
5. Save & Test

## Useful Commands

```bash
# View all containers
docker compose ps

# Restart collector
docker compose restart collector

# View real-time logs
docker compose logs -f

# Stop everything
docker compose down

# Update and restart
git pull && docker compose up -d --build
```

## Data Retention

By default, InfluxDB keeps data forever. To add a retention policy (e.g., 2 years):

1. Open InfluxDB UI
2. Go to Load Data → Buckets
3. Click on "span" bucket settings
4. Set retention period
