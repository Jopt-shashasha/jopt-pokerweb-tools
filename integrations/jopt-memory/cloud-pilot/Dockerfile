FROM python:3.12-slim
WORKDIR /opt/gateway
RUN pip install --no-cache-dir fastmcp==4.1.3 \
    && useradd --create-home --uid 10001 gateway \
    && install -d -o gateway -g gateway /state
ENV XDG_DATA_HOME=/state PYTHONDONTWRITEBYTECODE=1
COPY gateway.py .
USER gateway
CMD ["python", "gateway.py"]
