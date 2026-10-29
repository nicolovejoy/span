FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir httpx influxdb-client tzdata matplotlib "paho-mqtt>=2"

COPY collector.py .
COPY collector_health.py .
COPY span_v2.py .
COPY collector_v2.py .
COPY bath_detector.py .
COPY hvac_modes.py .
COPY attribution.py .
COPY hvac_classifier.py .
COPY charge_detector.py .
COPY weather_poller.py .
COPY wall_connector_poller.py .
COPY daily_report.py .
COPY report_baseline.py .
COPY rates.py .
COPY categories.json .
# backfill_rollups.py reads the task .flux files directly — it does not
# reimplement the pipeline, so both must ship together.
COPY backfill_rollups.py .
COPY influx_tasks/ ./influx_tasks/

CMD ["python", "-u", "collector.py"]
