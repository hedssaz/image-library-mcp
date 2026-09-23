FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 10001 imageapp \
    && mkdir /data && chown imageapp:imageapp /data
COPY server.py viewer.html THIRD_PARTY_NOTICES.txt ./
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 DATA_DIR=/data PORT=8000
USER imageapp
EXPOSE 8000
CMD ["python", "server.py"]
